#!/usr/bin/env python3
"""staged の ci-github スキルを配備先へ反映し、配備整合を検証する。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = Path(os.environ.get("A3_REPO_ROOT", SCRIPT_PATH.parents[4])).resolve()
SKILL_ROOT = Path("skills/ci-github")
DESTINATION_ENV = "A3_CI_GITHUB_SKILL_DEPLOY_ROOT"
CLI_ENV = "A3_PROJECT_SKILL_DEPLOY_CLI"
CLI_RELATIVE = Path("project-skill-deploy/scripts/deploy_project_skills.py")
EXCLUDED_PARTS = {"_build", "__pycache__", ".git"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo"}


def run_git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        check=False,
    )


def git_paths(*args: str) -> list[Path]:
    result = run_git(*args)
    if result.returncode != 0:
        message = os.fsdecode(result.stderr).strip() or "git command failed"
        raise RuntimeError(message)
    return [Path(os.fsdecode(item)) for item in result.stdout.split(b"\0") if item]


def is_deployable(path: Path) -> bool:
    if path != SKILL_ROOT and SKILL_ROOT not in path.parents:
        return False
    relative = path.relative_to(SKILL_ROOT) if path != SKILL_ROOT else Path()
    if any(part in EXCLUDED_PARTS for part in relative.parts):
        return False
    return path.suffix not in EXCLUDED_SUFFIXES


def staged_changes() -> list[tuple[str, Path]]:
    result = run_git(
        "diff",
        "--cached",
        "--no-renames",
        "--name-status",
        "-z",
        "--",
        SKILL_ROOT.as_posix(),
    )
    if result.returncode != 0:
        message = os.fsdecode(result.stderr).strip() or "git diff --cached failed"
        raise RuntimeError(message)
    fields = [item for item in result.stdout.split(b"\0") if item]
    if len(fields) % 2:
        raise RuntimeError("unexpected git diff --name-status output")
    return [
        (os.fsdecode(fields[index]), Path(os.fsdecode(fields[index + 1])))
        for index in range(0, len(fields), 2)
    ]


def deployable_staged_changes() -> list[tuple[str, Path]]:
    return [
        (status, path)
        for status, path in staged_changes()
        if is_deployable(path=path)
    ]


def index_has_skill_root() -> bool:
    return bool(
        git_paths(
            "ls-files",
            "--cached",
            "-z",
            "--",
            f"{SKILL_ROOT.as_posix()}/SKILL.md",
        )
    )


def unstaged_overlaps() -> list[str]:
    paths = [
        path
        for path in git_paths(
            "diff", "--name-only", "-z", "--", SKILL_ROOT.as_posix()
        )
        if is_deployable(path)
    ]
    paths.extend(
        path
        for path in git_paths(
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            SKILL_ROOT.as_posix(),
        )
        if is_deployable(path)
    )
    return sorted({path.as_posix() for path in paths})


def resolve_cli(destination: Path) -> Path:
    override = os.environ.get(CLI_ENV)
    if override:
        return Path(override).expanduser()
    return destination / CLI_RELATIVE


def run_cli(cli: Path, destination: Path, *extra: str) -> tuple[int, str, str]:
    result = subprocess.run(
        [
            sys.executable,
            str(cli),
            "--source-root",
            str(REPO_ROOT / "skills"),
            "--target-root",
            str(destination),
            "--json",
            *extra,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout, result.stderr


def parse_plan(stdout: str) -> dict[str, object]:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"deploy CLI returned invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("deploy CLI returned a non-object JSON payload")
    return payload


def as_list(plan: dict[str, object], key: str) -> list[object]:
    value = plan.get(key, [])
    return value if isinstance(value, list) else []


def blockers_from(plan: dict[str, object]) -> list[str]:
    items: list[str] = []
    for key in ("stale_files", "explicit_prune_skills", "replacement_skill_roots"):
        items.extend(str(item) for item in as_list(plan, key))
    return items


def main() -> int:
    try:
        if not deployable_staged_changes():
            print(
                "skill-deploy-parity: 非適用 "
                "(staged changes do not include deployable skills/ci-github files)"
            )
            return 0
        if not index_has_skill_root():
            print(
                "skill-deploy-parity: STOP: "
                "staged snapshot no longer contains skills/ci-github/SKILL.md",
                file=sys.stderr,
            )
            return 1
        overlaps = unstaged_overlaps()
        if overlaps:
            print(
                "skill-deploy-parity: STOP: "
                "対象 root に未ステージ差分または未追跡ファイルがあります。",
                file=sys.stderr,
            )
            for path in overlaps:
                print(f"- {path}", file=sys.stderr)
            return 1
        destination_value = os.environ.get(DESTINATION_ENV)
        if not destination_value:
            print(
                f"skill-deploy-parity: 非適用 ({DESTINATION_ENV} is not configured)"
            )
            return 0
        destination = Path(destination_value).expanduser().resolve()
        cli = resolve_cli(destination)
        if not cli.is_file():
            print(
                f"skill-deploy-parity: ERROR: deploy CLI not found: {cli}",
                file=sys.stderr,
            )
            return 2

        code, stdout, stderr = run_cli(cli, destination, "--dry-run")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy dry-run failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        plan = parse_plan(stdout)
        blockers = blockers_from(plan)
        if blockers:
            print(
                "skill-deploy-parity: STOP: 配備先に削除候補があります。"
                "削除を伴うデプロイは明示操作で実行してください。",
                file=sys.stderr,
            )
            for item in blockers:
                print(f"- {item}", file=sys.stderr)
            return 1

        updates = [str(item) for item in as_list(plan, "updates")]
        if not updates:
            print("skill-deploy-parity: PASS (updates=0, deletions=0)")
            return 0

        code, _stdout, stderr = run_cli(cli, destination, "--yes")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy apply failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        code, stdout, stderr = run_cli(cli, destination, "--dry-run")
        if code != 0:
            print(
                "skill-deploy-parity: ERROR: "
                f"deploy recheck failed: {stderr.strip()}",
                file=sys.stderr,
            )
            return 2
        remaining_plan = parse_plan(stdout)
        remaining = blockers_from(remaining_plan) + [
            str(item) for item in as_list(remaining_plan, "updates")
        ]
        if remaining:
            print(
                "skill-deploy-parity: STOP: 自動反映後も配備先に差分があります。",
                file=sys.stderr,
            )
            for item in remaining:
                print(f"- {item}", file=sys.stderr)
            return 1
        print(
            f"skill-deploy-parity: PASS "
            f"(auto-deployed updates={len(updates)}, deletions=0)"
        )
        return 0
    except Exception as error:
        print(f"skill-deploy-parity: ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
