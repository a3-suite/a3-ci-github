#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0"]
# ///
"""staged の公開スキルを配備先へ反映し、配備整合を検証する。"""

from __future__ import annotations

import argparse
import importlib
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Sequence

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = Path(os.environ.get("A3_REPO_ROOT", SCRIPT_PATH.parents[4])).resolve()
DEPLOY_API_PACKAGE = "project_skill_deployment"
EXPORT_ALL = ("--all", "--ignore-skip-worktree-bits")

ApiLoader = Callable[[Path], ModuleType]


def load_deploy_api(deploy_skill_root: Path) -> ModuleType:
    scripts = deploy_skill_root / "scripts"
    if not (scripts / DEPLOY_API_PACKAGE / "__init__.py").is_file():
        raise FileNotFoundError(f"project-skill-deploy API not found: {scripts}")
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    return importlib.import_module(DEPLOY_API_PACKAGE)


def run_git(
    repo_root: Path, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args], cwd=repo_root, capture_output=True, check=False, env=env
    )


def checked_git(repo_root: Path, *args: str, env: dict[str, str] | None = None) -> bytes:
    result = run_git(repo_root, *args, env=env)
    if result.returncode != 0:
        message = os.fsdecode(result.stderr).strip() or "git command failed"
        raise RuntimeError(message)
    return result.stdout


def head_exists(repo_root: Path) -> bool:
    if run_git(repo_root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").returncode == 0:
        return True
    # HEAD を解決できない理由が初回コミット前である場合だけ、変更前なしとして扱う。
    status = run_git(repo_root, "status", "--porcelain=v2", "--branch")
    if status.returncode == 0 and "# branch.oid (initial)" in os.fsdecode(status.stdout).splitlines():
        return False
    raise RuntimeError(os.fsdecode(status.stderr).strip() or "git cannot resolve HEAD")


def write_snapshots(repo_root: Path, directory: Path) -> tuple[Path | None, Path]:
    """HEAD と index の内容を、リポジトリの index を変えずに書き出す。"""
    staged = directory / "staged"
    # skip-worktree のエントリも index の内容なので、省略せずに書き出す。
    checked_git(repo_root, "checkout-index", *EXPORT_ALL, f"--prefix={staged}/")
    staged.mkdir(exist_ok=True)
    if not head_exists(repo_root):
        return None, staged
    base = directory / "base"
    env = {**os.environ, "GIT_INDEX_FILE": str(directory / "base.index")}
    checked_git(repo_root, "read-tree", "HEAD", env=env)
    checked_git(repo_root, "checkout-index", *EXPORT_ALL, f"--prefix={base}/", env=env)
    base.mkdir(exist_ok=True)
    return base, staged


def deletions(plan: Any) -> list[str]:
    items: list[str] = []
    for change in plan.targets:
        target = change.plan
        paths = [path.as_posix() for path in target.stale_files]
        paths += list(target.explicit_prune_skills) + list(target.replacement_skill_roots)
        items.extend(f"{target.target_root / path}" for path in paths)
    return items


def updates(plan: Any) -> list[str]:
    return [
        f"{change.plan.target_root / path}"
        for change in plan.targets
        for path in change.plan.copied_files
    ]


def destinations(plan: Any) -> list[str]:
    return [f"{change.target.env_key}={change.plan.target_root}" for change in plan.targets]


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-skill-deploy-root",
        type=Path,
        required=True,
        help="Root of the project-skill-deploy skill that owns the snapshot API.",
    )
    return parser.parse_args(argv)


def run_gate(args: argparse.Namespace, repo_root: Path, load_api: ApiLoader) -> int:
    if not checked_git(repo_root, "diff", "--cached", "--name-only", "-z"):
        print("skill-deploy-parity: 非適用 (no staged commit)")
        return 0
    api = load_api(args.project_skill_deploy_root)
    with tempfile.TemporaryDirectory() as directory:
        # macOS の一時領域は symlink 経由のため、実体パスで渡す。
        base, staged = write_snapshots(repo_root, Path(directory).resolve())

        def plan_change() -> Any:
            return api.plan_snapshot_change(repo_root, base_root=base, source_root=staged)

        plan = plan_change()
        # 変更したスキルは配備先ごとに算出されるため、配備先がなければ変更の有無も判定できない。
        if not plan.targets:
            print(
                "skill-deploy-parity: STOP: .env に配備先（SKILLS_<KEY>_DIR）がありません。",
                file=sys.stderr,
            )
            return 1
        for change in plan.targets:
            for residue in change.kept_residue:
                print(f"skill-deploy-parity: KEPT: {change.target.env_key}: {residue}")
        if not (plan.changed_skills or plan.removed_skills):
            print("skill-deploy-parity: 非適用 (no public skill change)")
            return 0
        if plan.needs_delete_confirmation:
            print(
                "skill-deploy-parity: STOP: 配備先に削除候補があります。"
                "削除を伴うデプロイは skills-deploy の明示操作で実行してください。",
                file=sys.stderr,
            )
            for item in deletions(plan):
                print(f"- {item}", file=sys.stderr)
            return 1
        applied = updates(plan)
        if applied:
            api.apply_snapshot_change(plan, delete_confirmed=False)
            remaining = plan_change()
            if destinations(remaining) != destinations(plan):
                print("skill-deploy-parity: STOP: 反映後の再検査で配備先が変わりました。", file=sys.stderr)
                return 1
            leftovers = updates(remaining) + deletions(remaining)
            if leftovers:
                print("skill-deploy-parity: STOP: 自動反映後も配備先に差分があります。", file=sys.stderr)
                for item in leftovers:
                    print(f"- {item}", file=sys.stderr)
                return 1
        print(f"skill-deploy-parity: PASS (auto-deployed updates={len(applied)}, deletions=0)")
        return 0


def main(
    argv: Sequence[str] | None = None,
    *,
    repo_root: Path = REPO_ROOT,
    load_api: ApiLoader = load_deploy_api,
) -> int:
    args = parse_args(argv)
    try:
        return run_gate(args, repo_root, load_api)
    except Exception as error:
        print(f"skill-deploy-parity: ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
