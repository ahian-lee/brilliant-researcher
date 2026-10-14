#!/usr/bin/env python3
"""Read-only diagnostics and a deterministic local paper-runtime smoke test.

The checker never starts Pi, invokes a model, installs a package, or changes a
global setting. --smoke writes only a private fixture below var/ and keeps its
CSV, PNG, TeX, BibTeX, PDF, render and command log as evidence.
"""

from __future__ import annotations

import argparse
import csv
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = SCRIPT_DIR.parents[1]


def root_from_argv(argv: list[str]) -> Path:
    for index, arg in enumerate(argv):
        if arg == "--root" and index + 1 < len(argv):
            return Path(argv[index + 1]).expanduser().resolve()
        if arg.startswith("--root="):
            return Path(arg.split("=", 1)[1]).expanduser().resolve()
    return DEFAULT_ROOT


def normalized_external_path(value: str | None) -> Path | None:
    """Accept a native path or a Windows path supplied by a WSL caller."""

    if not value:
        return None
    candidate = value
    if re.match(r"^[A-Za-z]:[\\/]", candidate):
        wslpath = shutil.which("wslpath")
        if wslpath:
            try:
                converted = subprocess.run(
                    [wslpath, "-u", candidate],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=5,
                ).stdout.strip()
                if converted:
                    candidate = converted
            except (OSError, subprocess.SubprocessError):
                pass
    return Path(candidate).expanduser()


def runtime_dir_from_env(root: Path) -> Path:
    configured = normalized_external_path(os.environ.get("ARIS_RUNTIME_DIR"))
    return configured.resolve() if configured else root / ".aris/runtime"


def maybe_reexec(argv: list[str]) -> None:
    """Use the project venv automatically when system Python was selected."""

    if "--no-reexec" in argv or os.environ.get("ARIS_RUNTIME_CHECK_REEXEC") == "1":
        return
    root = root_from_argv(argv)
    configured = os.environ.get("ARIS_RUNTIME_PYTHON")
    candidate = normalized_external_path(configured) if configured else runtime_dir_from_env(root) / "python/bin/python"
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        return
    venv_root = candidate.absolute().parent.parent.resolve()
    try:
        current = Path(sys.executable).resolve()
        target = candidate.resolve()
    except OSError:
        current, target = Path(sys.executable), candidate
    # venv/bin/python is commonly a symlink to /usr/bin/python3; comparing
    # only resolved executables would therefore mistake system Python for the
    # project interpreter.  sys.prefix distinguishes the active venv.
    if current == target and Path(sys.prefix).resolve() == venv_root:
        return
    env = os.environ.copy()
    env["ARIS_RUNTIME_CHECK_REEXEC"] = "1"
    # Preserve the venv launcher path here; executing the resolved symlink
    # would fall back to system Python and lose the venv's site-packages.
    launcher = candidate.absolute()
    os.execvpe(str(launcher), [str(launcher), str(Path(__file__).resolve()), *argv], env)


maybe_reexec(sys.argv[1:])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="upstream/aris project root")
    parser.add_argument("--paper", action="store_true", help="include TeX/Poppler checks")
    parser.add_argument("--smoke", action="store_true", help="run the deterministic CSV/plot/LaTeX fixture")
    parser.add_argument("--json", action="store_true", help="emit one JSON object")
    parser.add_argument(
        "--no-reexec",
        action="store_true",
        help="deliberately keep the current Python interpreter",
    )
    return parser.parse_args()


def version_for(module_name: str, package_name: str | None = None) -> str | None:
    package_name = package_name or module_name
    try:
        return importlib.metadata.version(package_name)
    except importlib.metadata.PackageNotFoundError:
        try:
            module = __import__(module_name)
            return str(getattr(module, "__version__", "installed"))
        except Exception:
            return None


def import_report() -> dict[str, dict[str, Any]]:
    specs = {
        "requests": ("requests", "requests"),
        "numpy": ("numpy", "numpy"),
        "matplotlib": ("matplotlib", "matplotlib"),
        "seaborn": ("seaborn", "seaborn"),
        "pypdf": ("pypdf", "pypdf"),
        "pymupdf": ("pymupdf", "PyMuPDF"),
    }
    result: dict[str, dict[str, Any]] = {}
    for label, (module_name, package_name) in specs.items():
        present = importlib.util.find_spec(module_name) is not None
        result[label] = {
            "module": module_name,
            "present": present,
            "version": version_for(module_name, package_name) if present else None,
        }
    return result


def normalized_command_path(value: str | None) -> Path | None:
    configured = normalized_external_path(value)
    if configured and configured.is_file() and os.access(configured, os.X_OK):
        return configured
    return None


def command_path(
    name: str,
    root: Path,
    runtime_dir: Path,
    poppler_root: Path | None = None,
) -> Path | None:
    configured_key = {
        "latexmk": "ARIS_LATEXMK",
        "pdflatex": "ARIS_PDFLATEX",
        "bibtex": "ARIS_BIBTEX",
        "pdfinfo": "ARIS_PDFINFO",
        "pdftotext": "ARIS_PDFTOTEXT",
        "pdftoppm": "ARIS_PDFTOPPM",
    }.get(name)
    if configured_key:
        configured = normalized_command_path(os.environ.get(configured_key))
        if configured:
            return configured
    project_bin = runtime_dir / "bin" / name
    if project_bin.is_file() and os.access(project_bin, os.X_OK):
        return project_bin
    if poppler_root and name in {"pdfinfo", "pdftotext", "pdftoppm"}:
        # Accept either the extracted Ubuntu package root or a configured
        # standalone bin directory (for example a Windows/Codex bundle).
        for private in (
            poppler_root / "usr/bin" / name,
            poppler_root / "bin" / name,
            poppler_root / name,
        ):
            if private.is_file() and os.access(private, os.X_OK):
                return private
    found = shutil.which(name)
    return Path(found) if found else None


def poppler_root_from_env(root: Path, runtime_dir: Path) -> Path | None:
    configured = normalized_external_path(os.environ.get("ARIS_POPPLER_DIR"))
    if configured:
        return configured
    candidate = runtime_dir / "poppler"
    return candidate if candidate.exists() else None


def private_library_path(poppler_root: Path | None) -> str | None:
    if not poppler_root or not poppler_root.exists():
        return None
    dirs = sorted(
        {
            str(path)
            for path in poppler_root.rglob("*")
            if path.is_dir() and path.name in {"lib", "lib64", "x86_64-linux-gnu"}
        }
    )
    return os.pathsep.join(dirs) if dirs else None


def command_report(root: Path, paper: bool) -> tuple[dict[str, Any], Path | None, str | None]:
    runtime_dir = runtime_dir_from_env(root)
    poppler_root = poppler_root_from_env(root, runtime_dir)
    names = ["latexmk", "pdflatex", "bibtex"] if paper else []
    if paper:
        names += ["pdfinfo", "pdftotext", "pdftoppm"]
    report: dict[str, Any] = {}
    for name in names:
        path = command_path(name, root, runtime_dir, poppler_root)
        report[name] = {"present": path is not None, "path": str(path) if path else None}
    return report, poppler_root, private_library_path(poppler_root)


def run_command(
    command: list[str],
    cwd: Path,
    log_handle: Any | None = None,
    env: dict[str, str] | None = None,
    timeout: int = 180,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdout=log_handle if log_handle is not None else subprocess.PIPE,
        stderr=subprocess.STDOUT if log_handle is not None else subprocess.PIPE,
        text=True,
        check=False,
        timeout=timeout,
    )


def latex_source() -> tuple[str, str]:
    tex = r"""\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{graphicx}
\title{ARIS runtime smoke}
\author{Deterministic fixture}
\begin{document}
\maketitle
This is a deterministic runtime check, not a user paper.
The generated CSV and figure are local test artifacts. Citation: \cite{knuth1984}.

\begin{figure}[h]
  \centering
  \includegraphics[width=0.72\linewidth]{figure.png}
  \caption{A deterministic linear fixture.}
\end{figure}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
"""
    bib = r"""@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The TeXbook},
  year = {1984},
  publisher = {Addison-Wesley}
}
"""
    return tex, bib


def write_fixture_data(directory: Path) -> None:
    with (directory / "data.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["x", "y"])
        for x in range(11):
            writer.writerow([x, 2 * x + 1])


def generate_plot(directory: Path) -> None:
    os.environ.setdefault("MPLBACKEND", "Agg")
    import matplotlib.pyplot as plt  # type: ignore

    xs = list(range(11))
    ys = [2 * x + 1 for x in xs]
    figure, axis = plt.subplots(figsize=(5, 3))
    axis.plot(xs, ys, marker="o")
    axis.set_title("ARIS runtime smoke")
    axis.set_xlabel("x")
    axis.set_ylabel("y = 2x + 1")
    figure.tight_layout()
    figure.savefig(directory / "figure.png", dpi=120)
    plt.close(figure)


def extract_pdf(pdf: Path) -> tuple[int, str, str]:
    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(str(pdf))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        return len(reader.pages), text, "pypdf"
    except Exception as pypdf_error:
        try:
            import pymupdf  # type: ignore

            document = pymupdf.open(str(pdf))
            text = "\n".join(page.get_text() for page in document)
            pages = len(document)
            document.close()
            return pages, text, f"pymupdf (pypdf error: {pypdf_error})"
        except Exception as pymupdf_error:
            raise RuntimeError(f"could not read PDF with pypdf or pymupdf: {pymupdf_error}") from pymupdf_error


def render_pdf(pdf: Path, output: Path, command: Path | None, env: dict[str, str]) -> str:
    if command:
        result = run_command(
            [str(command), "-f", "1", "-singlefile", "-png", str(pdf), str(output.with_suffix(""))],
            pdf.parent,
            env=env,
        )
        rendered = output.with_suffix(".png")
        if result.returncode == 0 and rendered.is_file():
            return f"pdftoppm: {rendered}"
    try:
        import pymupdf  # type: ignore

        document = pymupdf.open(str(pdf))
        page = document[0]
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.4, 1.4), alpha=False)
        pixmap.save(str(output))
        document.close()
        return f"pymupdf: {output}"
    except Exception as error:
        raise RuntimeError(f"could not render PDF first page: {error}") from error


def verify_external_pdf_tools(
    pdf: Path,
    commands: dict[str, Any],
    env: dict[str, str],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    pdfinfo = commands.get("pdfinfo", {}).get("path")
    if pdfinfo:
        proc = run_command([pdfinfo, str(pdf)], pdf.parent, env=env)
        result["pdfinfo"] = {"returncode": proc.returncode, "pages": None}
        if proc.returncode == 0:
            match = re.search(r"^Pages:\s+(\d+)", proc.stdout or "", re.MULTILINE)
            result["pdfinfo"]["pages"] = int(match.group(1)) if match else None
    else:
        result["pdfinfo"] = {"present": False}
    pdftotext = commands.get("pdftotext", {}).get("path")
    if pdftotext:
        text_path = pdf.with_suffix(".external.txt")
        proc = run_command([pdftotext, str(pdf), str(text_path)], pdf.parent, env=env)
        extracted = text_path.read_text(encoding="utf-8", errors="replace") if text_path.exists() else ""
        result["pdftotext"] = {"returncode": proc.returncode, "contains_title": "ARIS runtime smoke" in extracted}
    else:
        result["pdftotext"] = {"present": False}
    return result


def run_smoke(
    root: Path,
    commands: dict[str, Any],
    poppler_root: Path | None,
    poppler_lib_path: str | None,
) -> dict[str, Any]:
    required_imports = import_report()
    missing = [name for name, info in required_imports.items() if not info["present"]]
    if missing:
        raise RuntimeError("runtime Python imports are missing: " + ", ".join(missing))
    missing_tex = [name for name in ("pdflatex", "bibtex") if not commands.get(name, {}).get("path")]
    if missing_tex:
        raise RuntimeError(
            "paper smoke requires pdflatex and bibtex; install those host prerequisites "
            "(setup does not install texlive-full): " + ", ".join(missing_tex)
        )

    var_dir = root / "var"
    var_dir.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="runtime-smoke-", dir=var_dir))
    write_fixture_data(directory)
    generate_plot(directory)
    tex, bib = latex_source()
    (directory / "paper.tex").write_text(tex, encoding="utf-8")
    (directory / "refs.bib").write_text(bib, encoding="utf-8")
    log_path = directory / "smoke.log"
    env = os.environ.copy()
    env["MPLBACKEND"] = "Agg"
    path_parts = [str(runtime_dir_from_env(root) / "bin")]
    if poppler_root:
        for candidate in (poppler_root / "usr/bin", poppler_root / "bin"):
            if candidate.is_dir():
                path_parts.append(str(candidate))
    path_parts.append(env.get("PATH", ""))
    env["PATH"] = os.pathsep.join(part for part in path_parts if part)
    if poppler_lib_path:
        env["LD_LIBRARY_PATH"] = poppler_lib_path + (
            os.pathsep + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else ""
        )

    latexmk = commands.get("latexmk", {}).get("path")
    with log_path.open("w", encoding="utf-8") as log:
        if latexmk:
            command = [
                latexmk,
                "-pdf",
                "-bibtex",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "paper.tex",
            ]
            proc = run_command(command, directory, log_handle=log, env=env)
            build_method = "latexmk"
        else:
            build_method = "pdflatex+bibtex fallback"
            proc = run_command(
                [commands["pdflatex"]["path"], "-interaction=nonstopmode", "-halt-on-error", "paper.tex"],
                directory,
                log_handle=log,
                env=env,
            )
            if proc.returncode == 0:
                proc = run_command([commands["bibtex"]["path"], "paper"], directory, log_handle=log, env=env)
            for _ in range(2):
                if proc.returncode != 0:
                    break
                proc = run_command(
                    [commands["pdflatex"]["path"], "-interaction=nonstopmode", "-halt-on-error", "paper.tex"],
                    directory,
                    log_handle=log,
                    env=env,
                )
    pdf = directory / "paper.pdf"
    if proc.returncode != 0 or not pdf.is_file():
        raise RuntimeError(f"LaTeX build failed (returncode={proc.returncode}); see {log_path}")
    pages, text, extractor = extract_pdf(pdf)
    required_tokens = ["ARIS runtime smoke", "deterministic runtime check", "Knuth"]
    missing_tokens = [token for token in required_tokens if token not in text]
    if pages < 1 or missing_tokens:
        raise RuntimeError(f"PDF verification failed: pages={pages}, missing text={missing_tokens}")
    external = verify_external_pdf_tools(pdf, commands, env)
    render_path = directory / "page-1.png"
    render_method = render_pdf(
        pdf,
        render_path,
        Path(commands["pdftoppm"]["path"]) if commands.get("pdftoppm", {}).get("path") else None,
        env,
    )
    return {
        "passed": True,
        "directory": str(directory),
        "files": sorted(path.name for path in directory.iterdir()),
        "build_method": build_method,
        "build_returncode": proc.returncode,
        "pdf": str(pdf),
        "pages": pages,
        "text_contains": required_tokens,
        "text_extractor": extractor,
        "external_pdf_tools": external,
        "render": render_method,
        "log": str(log_path),
    }


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    runtime_dir = runtime_dir_from_env(root)
    if args.smoke:
        args.paper = True
    imports = import_report()
    commands, poppler_root, poppler_lib_path = command_report(root, args.paper)
    report: dict[str, Any] = {
        "root": str(root),
        "runtime_dir": str(runtime_dir),
        "python": {"executable": sys.executable, "version": sys.version.split()[0]},
        "imports": imports,
        "commands": commands,
        "poppler_root": str(poppler_root) if poppler_root else None,
        "poppler_library_path": poppler_lib_path,
        "paper_prerequisites": (
            {name: bool(info.get("present")) for name, info in commands.items()} if args.paper else None
        ),
        "smoke": None,
        "warnings": [],
    }
    if args.paper:
        for name in ("pdflatex", "bibtex", "latexmk"):
            if not commands.get(name, {}).get("present"):
                report["warnings"].append(
                    f"missing {name}; install host paper prerequisites; setup does not install texlive-full"
                )
        for name in ("pdfinfo", "pdftotext", "pdftoppm"):
            if not commands.get(name, {}).get("present"):
                report["warnings"].append(
                    f"missing {name}; pypdf/PyMuPDF can provide smoke extraction, or configure ARIS_POPPLER_DIR"
                )
    if args.smoke:
        try:
            report["smoke"] = run_smoke(root, commands, poppler_root, poppler_lib_path)
        except Exception as error:
            report["smoke"] = {"passed": False, "error": str(error)}
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 2
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"runtime root: {root}")
        print(f"python: {sys.executable} ({sys.version.split()[0]})")
        for name, info in imports.items():
            version = info.get("version") or "missing"
            print(f"python {name}: {version}")
        if args.paper:
            for name, info in commands.items():
                print(f"{name}: {info.get('path') or 'missing'}")
            for warning in report["warnings"]:
                print(f"warning: {warning}")
        if args.smoke:
            print(f"smoke: {report['smoke']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

