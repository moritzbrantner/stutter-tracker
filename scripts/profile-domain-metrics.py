#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(message)


def load_target(scenario_path: Path) -> tuple[Path, list[str], Path, int, int]:
    program: str | None = None
    args: list[str] | None = None
    working_directory: str | None = None
    warmups = 1
    iterations = 5

    for raw_line in scenario_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("program:"):
            program = line.split(":", 1)[1].strip()
        elif line.startswith("args:"):
            args = json.loads(line.split(":", 1)[1].strip())
        elif line.startswith("working_directory:"):
            working_directory = line.split(":", 1)[1].strip()
        elif line.startswith("warmup_iterations:"):
            warmups = int(line.split(":", 1)[1].strip())
        elif line.startswith("measurement_iterations:"):
            iterations = int(line.split(":", 1)[1].strip())

    if program is None or args is None:
        fail(f"scenario does not declare a command target: {scenario_path}")

    scenario_directory = scenario_path.parent.resolve()
    cwd = (
        scenario_directory
        if working_directory is None
        else (scenario_directory / working_directory).resolve()
    )
    executable = Path(program)
    if not executable.is_absolute():
        executable = (cwd / executable).resolve()

    return executable, args, cwd, warmups, iterations


def run_once(executable: Path, args: list[str], cwd: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [str(executable), *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        fail("speech-analysis workload produced no JSON output")
    value = json.loads(lines[-1])
    if value.get("schemaVersion") != 1 or value.get("workload") != "speech-analysis":
        fail("speech-analysis workload returned an unsupported domain schema")
    return value


def summarize(values: list[float]) -> dict[str, float | int]:
    ordered = sorted(values)
    p95_index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * 0.95) - 1))
    return {
        "sampleCount": len(ordered),
        "minimum": ordered[0],
        "maximum": ordered[-1],
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "p95": ordered[p95_index],
    }


def main() -> None:
    if len(sys.argv) != 3:
        fail(f"usage: {sys.argv[0]} <scenario.yaml> <output.json>")

    scenario_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    executable, args, cwd, warmups, iterations = load_target(scenario_path)

    if not executable.is_file():
        fail(f"profile workload binary does not exist: {executable}")

    for _ in range(warmups):
        run_once(executable, args, cwd)
    samples = [run_once(executable, args, cwd) for _ in range(iterations)]

    metric_names = ["elapsedSeconds", "realTimeFactor", "eventCount", "wordCount"]
    metrics = {
        name: summarize([float(sample[name]) for sample in samples]) for name in metric_names
    }
    analyzed_audio = [
        float(sample["analyzedAudioSeconds"])
        for sample in samples
        if sample.get("analyzedAudioSeconds") is not None
    ]
    if analyzed_audio:
        metrics["analyzedAudioSeconds"] = summarize(analyzed_audio)

    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    output = {
        "schemaVersion": "stutter-tracker/domain-performance/v1",
        "scenario": scenario_path.stem,
        "sourceRevision": revision,
        "warmupIterations": warmups,
        "measurementIterations": iterations,
        "target": {"program": str(executable.relative_to(cwd)), "args": args},
        "metrics": metrics,
        "samples": samples,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(output_path)


if __name__ == "__main__":
    main()
