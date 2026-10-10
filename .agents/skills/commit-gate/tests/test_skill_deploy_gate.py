"""コミット時の配備漏れと、未承認の削除・未ステージ内容の配備を防ぐ。"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(__file__).resolve().parents[1] / "scripts/check_staged_skill_deploy.py"
PROJECT_ROOT = GATE.parents[4]


class SkillDeployGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="skill-deploy-gate-", dir=PROJECT_ROOT / "tmp"
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.target = self.root / "target"
        self.target.mkdir()
        self.cli = self.root / "deploy.py"
        self.cli.write_text(
            """import argparse, json
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--source-root')
p.add_argument('--target-root')
p.add_argument('--json', action='store_true')
p.add_argument('--dry-run', action='store_true')
p.add_argument('--yes', action='store_true')
a = p.parse_args()
s = Path(a.source_root) / 'demo/SKILL.md'
t = Path(a.target_root) / 'demo/SKILL.md'
updates = [] if t.is_file() and t.read_bytes() == s.read_bytes() else ['demo/SKILL.md']
stale = ['stale.txt'] if (Path(a.target_root) / 'stale.txt').exists() else []
if not a.dry_run:
    t.parent.mkdir(exist_ok=True)
    t.write_bytes(s.read_bytes())
print(json.dumps({'updates': updates, 'stale_files': stale}))
""",
            encoding="utf-8",
        )
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        skill = self.repo / "skills/demo/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("current public skill\n", encoding="utf-8")
        (self.repo / "README.md").write_text("initial\n", encoding="utf-8")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=self.repo, text=True, capture_output=True, check=True
        )

    def stage_repository_change(self) -> None:
        (self.repo / "README.md").write_text("changed\n", encoding="utf-8")
        self.git("add", "README.md")

    def configure_destination(self) -> None:
        self.git("config", "--local", "a3-ci-github.skillDeployRoot", str(self.target))

    def run_gate(self) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.pop("A3_CI_GITHUB_SKILL_DEPLOY_ROOT", None)
        environment.update(
            A3_REPO_ROOT=str(self.repo), A3_PROJECT_SKILL_DEPLOY_CLI=str(self.cli)
        )
        return subprocess.run(
            [sys.executable, str(GATE)], env=environment, text=True,
            capture_output=True, check=False,
        )

    def test_non_skill_commit_repairs_existing_deployment_drift(self) -> None:
        self.configure_destination()
        self.stage_repository_change()
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("auto-deployed", result.stdout)
        self.assertEqual(
            (self.target / "demo/SKILL.md").read_bytes(),
            (self.repo / "skills/demo/SKILL.md").read_bytes(),
        )

    def test_missing_destination_stops_commit(self) -> None:
        self.stage_repository_change()
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("STOP", result.stderr)
        self.assertFalse((self.target / "demo").exists())

    def test_no_staged_commit_is_not_applicable(self) -> None:
        result = self.run_gate()
        self.assertEqual(result.returncode, 0)
        self.assertIn("非適用", result.stdout)

    def test_unstaged_public_source_is_not_deployed(self) -> None:
        self.configure_destination()
        self.stage_repository_change()
        (self.repo / "skills/demo/SKILL.md").write_text("unstaged\n", encoding="utf-8")
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.target / "demo").exists())

    def test_deletion_candidate_stops_before_updates(self) -> None:
        self.configure_destination()
        self.stage_repository_change()
        (self.target / "stale.txt").write_text("keep\n", encoding="utf-8")
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.target / "demo").exists())
        self.assertTrue((self.target / "stale.txt").exists())

    def test_ignored_untracked_public_source_is_not_deployed(self) -> None:
        self.configure_destination()
        self.stage_repository_change()
        (self.repo / ".gitignore").write_text("local-only.md\n", encoding="utf-8")
        (self.repo / "skills/demo/local-only.md").write_text("local only\n", encoding="utf-8")
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.target / "demo").exists())

    def test_nested_git_metadata_is_not_deployed(self) -> None:
        self.configure_destination()
        self.stage_repository_change()
        metadata = self.repo / "skills/demo/.git/config"
        metadata.parent.mkdir()
        metadata.write_text("local metadata\n", encoding="utf-8")
        result = self.run_gate()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.target / "demo").exists())


if __name__ == "__main__":
    unittest.main()
