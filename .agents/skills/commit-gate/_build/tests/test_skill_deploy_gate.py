"""コミット時の配備漏れと、未承認の削除・未ステージ内容の配備を防ぐ。"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

GATE = Path(__file__).resolve().parents[2] / "scripts/check_staged_skill_deploy.py"
PROJECT_ROOT = GATE.parents[4]
SPEC = importlib.util.spec_from_file_location("check_staged_skill_deploy", GATE)
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class FakeApi:
    """配備判定を持たず、渡されたスナップショットと反映呼出しだけを記録する。"""

    def __init__(self, plans: list[SimpleNamespace], error: Exception | None = None) -> None:
        self.plans = plans
        self.error = error
        self.snapshots: list[tuple[str | None, str]] = []
        self.applied: list[bool] = []

    def plan_snapshot_change(self, project_root: Path, *, base_root: Path | None, source_root: Path):
        if self.error:
            raise self.error
        read = lambda root: (root / "skills/demo/SKILL.md").read_text(encoding="utf-8") if root else None
        self.snapshots.append((read(base_root), read(source_root)))
        return self.plans.pop(0)

    def apply_snapshot_change(self, plan: SimpleNamespace, *, delete_confirmed: bool) -> None:
        self.applied.append(delete_confirmed)


def plan(*, targets: bool = True, changed: bool = True, copied: tuple[str, ...] = (), stale: tuple[str, ...] = ()) -> SimpleNamespace:
    target = SimpleNamespace(
        target=SimpleNamespace(env_key="SKILLS_CODEX_DIR"),
        kept_residue=(),
        plan=SimpleNamespace(
            target_root=Path("/target"), copied_files=tuple(Path(p) for p in copied),
            stale_files=tuple(Path(p) for p in stale), explicit_prune_skills=(), replacement_skill_roots=(),
        ),
    )
    return SimpleNamespace(
        targets=(target,) if targets else (), changed_skills=("skills/demo",) if changed else (),
        removed_skills=(), needs_delete_confirmation=bool(stale),
    )


# test_level: integration
# flow_id: repository-staged-skill-deploy-gate
class SkillDeployGateTest(unittest.TestCase):
    def setUp(self) -> None:
        (PROJECT_ROOT / "tmp").mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="skill-deploy-gate-", dir=PROJECT_ROOT / "tmp")
        self.addCleanup(temporary.cleanup)
        self.repo = Path(temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        self.skill = self.repo / "skills/demo/SKILL.md"
        self.skill.parent.mkdir(parents=True)
        self.skill.write_text("committed\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.repo, capture_output=True, check=True)

    def stage(self, text: str) -> None:
        self.skill.write_text(text, encoding="utf-8")
        self.git("add", ".")

    def run_gate(self, api: FakeApi) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = gate.main(["--project-skill-deploy-root", "/unused"], repo_root=self.repo, load_api=lambda _root: api)
        return code, output.getvalue()

    def test_staged_snapshot_is_planned_and_unstaged_content_is_not(self) -> None:
        # Arrange
        self.stage("staged\n")
        self.skill.write_text("unstaged\n", encoding="utf-8")
        api = FakeApi([plan(copied=("demo/SKILL.md",)), plan()])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 0, output)
        self.assertEqual(api.snapshots[0], ("committed\n", "staged\n"))
        self.assertEqual(api.applied, [False])
        self.assertIn("PASS (auto-deployed updates=1, deletions=0)", output)

    def test_no_staged_commit_is_not_applicable(self) -> None:
        # Arrange
        api = FakeApi([])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 0)
        self.assertIn("非適用", output)
        self.assertEqual(api.snapshots, [])

    def test_missing_destination_stops_commit(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([plan(targets=False)])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 1)
        self.assertIn("SKILLS_<KEY>_DIR", output)
        self.assertEqual(api.applied, [])

    def test_commit_without_skill_change_is_not_applicable(self) -> None:
        # Arrange
        (self.repo / "README.md").write_text("changed\n", encoding="utf-8")
        self.git("add", "README.md")
        api = FakeApi([plan(changed=False)])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 0)
        self.assertIn("no public skill change", output)
        self.assertEqual(api.applied, [])

    def test_deletion_candidate_stops_before_updates(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([plan(copied=("demo/SKILL.md",), stale=("demo/old.md",))])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 1)
        self.assertIn("/target/demo/old.md", output)
        self.assertEqual(api.applied, [])

    def test_matching_destination_passes_without_writing(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([plan()])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 0)
        self.assertIn("updates=0", output)
        self.assertEqual(api.applied, [])

    def test_remaining_drift_after_apply_stops(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([plan(copied=("demo/SKILL.md",)), plan(copied=("demo/SKILL.md",))])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 1)
        self.assertIn("自動反映後も", output)

    def test_destination_change_after_apply_stops(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([plan(copied=("demo/SKILL.md",)), plan(targets=False)])
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 1)
        self.assertIn("配備先が変わりました", output)

    def test_api_failure_is_undeterminable(self) -> None:
        # Arrange
        self.stage("staged\n")
        api = FakeApi([], error=ValueError("invalid config"))
        # Act
        code, output = self.run_gate(api)
        # Assert
        self.assertEqual(code, 2)
        self.assertIn("ERROR: invalid config", output)


if __name__ == "__main__":
    unittest.main()
