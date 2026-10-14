#!/usr/bin/env bash
# Prepare the optional, project-local ARIS/Pi paper and web runtime.
#
# This script is explicit: importing pi-aris.sh or starting a normal
# interactive Pi session never invokes it. Network operations happen only
# after the user runs this script.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ARIS_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
RUNTIME_DIR="${ARIS_RUNTIME_DIR:-$ARIS_ROOT/.aris/runtime}"
PYTHON_CMD="${ARIS_PYTHON:-python3}"
PIP_INDEX="${PIP_INDEX_URL:-https://pypi.org/simple}"
POPPLER_BASE_URL="${ARIS_POPPLER_BASE_URL:-https://security.ubuntu.com/ubuntu/pool/main/p/poppler/}"

DO_PAPER=0
DO_WEB=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --paper) DO_PAPER=1 ;;
    --web) DO_WEB=1 ;;
    --all) DO_PAPER=1; DO_WEB=1 ;;
    --check-only|--check) CHECK_ONLY=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: setup-runtime.sh [--paper] [--web] [--all] [--check-only]

Create or complete the project-local runtime under .aris/runtime. Python
dependencies are installed into .aris/runtime/python. --paper checks the
system/project TeX tools and, when Poppler is absent, may download and unpack
the two official Ubuntu .deb files into .aris/runtime/poppler. It never uses
apt or changes system libraries. --web installs npm:pi-web-access into
.aris/runtime/web only when that official extension is not already present.

Network access is performed only when this script is explicitly run. Set
PIP_INDEX_URL to choose a Python package index, ARIS_POPPLER_BASE_URL to choose
an official Poppler mirror, or ARIS_RUNTIME_DIR/ARIS_PYTHON for project-local
layout and interpreter selection.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Use --help for usage." >&2
      exit 2
      ;;
  esac
done

die() {
  echo "setup-runtime: $*" >&2
  exit 1
}

command -v "$PYTHON_CMD" >/dev/null 2>&1 || die "Python interpreter not found: $PYTHON_CMD"
if [ "$CHECK_ONLY" = 1 ]; then
  check_args=(--root "$ARIS_ROOT" --json)
  [ "$DO_PAPER" = 1 ] && check_args+=(--paper)
  exec "$PYTHON_CMD" "$SCRIPT_DIR/runtime-check.py" "${check_args[@]}"
fi
mkdir -p "$RUNTIME_DIR" "$RUNTIME_DIR/downloads"

VENV_DIR="$RUNTIME_DIR/python"
VENV_PY="$VENV_DIR/bin/python"
GET_PIP="$RUNTIME_DIR/downloads/get-pip.py"
PAPER_INCOMPLETE=0
POPPLER_SOURCE=""
POPPLER_PACKAGES=""

ensure_venv() {
  if [ ! -f "$VENV_DIR/pyvenv.cfg" ]; then
    mkdir -p "$VENV_DIR"
    if ! "$PYTHON_CMD" -m venv "$VENV_DIR"; then
      echo "setup-runtime: ensurepip is unavailable; retrying a pip-less venv." >&2
      "$PYTHON_CMD" -m venv --without-pip "$VENV_DIR" \
        || die "could not create a Python venv at $VENV_DIR"
    fi
  fi
  [ -x "$VENV_PY" ] || die "venv Python is missing: $VENV_PY"

  if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
    if [ ! -s "$GET_PIP" ]; then
      command -v curl >/dev/null 2>&1 \
        || die "curl is required to obtain the official pip bootstrap"
      local tmp="$GET_PIP.tmp.$$"
      curl --fail --location --retry 2 --silent --show-error \
        https://bootstrap.pypa.io/get-pip.py -o "$tmp" \
        || { rm -f -- "$tmp"; die "could not download bootstrap.pypa.io/get-pip.py"; }
      mv -- "$tmp" "$GET_PIP"
    fi
    # The bootstrap is project-local and is used only because ensurepip was
    # unavailable. It is never executed while a normal Pi run is starting.
    "$VENV_PY" "$GET_PIP" --no-warn-script-location \
      || die "the official pip bootstrap failed"
  fi
}

ensure_python_packages() {
  local missing=()
  local package import_name package_specs_entry
  declare -a package_specs=(
    "requests:requests"
    "numpy:numpy"
    "matplotlib:matplotlib"
    "seaborn:seaborn"
    "pypdf:pypdf"
    "pymupdf:pymupdf"
  )
  for package_specs_entry in "${package_specs[@]}"; do
    package="${package_specs_entry%%:*}"
    import_name="${package_specs_entry#*:}"
    if ! "$VENV_PY" - "$import_name" >/dev/null 2>&1 <<'PY'
import importlib.util
import sys
name = sys.argv[1]
raise SystemExit(0 if importlib.util.find_spec(name) else 1)
PY
    then
      missing+=("$package")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "setup-runtime: installing missing Python packages: ${missing[*]}" >&2
    "$VENV_PY" -m pip install --disable-pip-version-check \
      --index-url "$PIP_INDEX" "${missing[@]}" \
      || die "Python dependency installation failed"
  fi
}

select_poppler_deb() {
  local package="$1"
  local index="$2"
  "$PYTHON_CMD" - "$package" "$index" <<'PY'
import re
import sys
from pathlib import Path

package, index_path = sys.argv[1:]
text = Path(index_path).read_text(encoding="utf-8", errors="replace")
names = re.findall(r'href=["\x27]([^"\x27]+\.deb)["\x27]', text)
matches = sorted({Path(name).name for name in names
                  if Path(name).name.startswith(package + "_")
                  and Path(name).name.endswith("_amd64.deb")})
preferred = [name for name in matches if "22.02.0-2ubuntu0.13" in name]
if preferred:
    print(preferred[0])
elif matches:
    # Only use this fallback when a mirror no longer carries the pinned
    # Jammy security update.
    print(matches[-1])
else:
    raise SystemExit(f"no amd64 {package} package in {index_path}")
PY
}

private_poppler_ld_path() {
  local root="$1"
  local dirs=()
  while IFS= read -r dir; do
    [ -n "$dir" ] && dirs+=("$dir")
  done < <(find "$root" -type d \( -name 'lib' -o -name 'lib64' -o -name 'x86_64-linux-gnu' \) -print 2>/dev/null | sort -u)
  local joined=""
  local dir
  for dir in "${dirs[@]}"; do
    if [ -n "$joined" ]; then joined="$joined:$dir"; else joined="$dir"; fi
  done
  printf '%s' "$joined"
}

check_private_poppler() {
  local root="$1"
  local ld_path
  ld_path="$(private_poppler_ld_path "$root")"
  local missing=0
  local tool path output
  for tool in pdfinfo pdftotext pdftoppm; do
    path="$root/usr/bin/$tool"
    [ -x "$path" ] || continue
    echo "setup-runtime: ldd $tool" >&2
    output="$(LD_LIBRARY_PATH="$ld_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      ldd "$path" 2>&1 || true)"
    printf '%s\n' "$output" >&2
    if grep -q 'not found' <<<"$output"; then
      missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    echo "setup-runtime: private Poppler has unresolved libraries; no dependency package was guessed or installed." >&2
    echo "setup-runtime: inspect ldd output above and provide the needed dependency through the host/runtime policy." >&2
    return 2
  fi
  return 0
}

ensure_poppler() {
  local poppler_root="$RUNTIME_DIR/poppler"
  local index="$RUNTIME_DIR/downloads/poppler-index.html"
  local deb_dir="$RUNTIME_DIR/downloads/poppler"
  local lib_name utils_name lib_deb utils_deb deb tmp
  mkdir -p "$deb_dir"

  if [ ! -s "$index" ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required to obtain the official Poppler index"
    tmp="$index.tmp.$$"
    curl --fail --location --retry 2 --silent --show-error \
      "$POPPLER_BASE_URL" -o "$tmp" \
      || { rm -f -- "$tmp"; die "could not download official Poppler index: $POPPLER_BASE_URL"; }
    mv -- "$tmp" "$index"
  fi

  lib_name="$(select_poppler_deb libpoppler118 "$index")" \
    || die "libpoppler118 was not found in the official Poppler index"
  utils_name="$(select_poppler_deb poppler-utils "$index")" \
    || die "poppler-utils was not found in the official Poppler index"
  # Avoid mixing a Jammy libpoppler ABI with a different poppler-utils build.
  if [ "${lib_name#libpoppler118_}" != "${utils_name#poppler-utils_}" ]; then
    echo "setup-runtime: official index selected a mismatched Poppler pair:" >&2
    echo "  $lib_name" >&2
    echo "  $utils_name" >&2
    die "refusing to unpack mismatched Poppler packages"
  fi
  lib_deb="$deb_dir/$lib_name"
  utils_deb="$deb_dir/$utils_name"
  for deb in "$lib_deb" "$utils_deb"; do
    if [ ! -s "$deb" ]; then
      command -v curl >/dev/null 2>&1 || die "curl is required to obtain Poppler .deb files"
      tmp="$deb.tmp.$$"
      curl --fail --location --retry 2 --silent --show-error \
        "${POPPLER_BASE_URL%/}/$(basename "$deb")" -o "$tmp" \
        || { rm -f -- "$tmp"; die "could not download $(basename "$deb")"; }
      mv -- "$tmp" "$deb"
    fi
  done
  command -v dpkg-deb >/dev/null 2>&1 \
    || die "dpkg-deb is required to unpack Poppler without changing apt/system state"
  mkdir -p "$poppler_root"
  dpkg-deb -x "$lib_deb" "$poppler_root"
  dpkg-deb -x "$utils_deb" "$poppler_root"
  if ! check_private_poppler "$poppler_root"; then
    echo "setup-runtime: Poppler files were retained at $poppler_root for diagnosis." >&2
  fi
  POPPLER_SOURCE="$POPPLER_BASE_URL"
  POPPLER_PACKAGES="$lib_name,$utils_name"
}

ensure_web() {
  local web_dir="$RUNTIME_DIR/web"
  mkdir -p "$web_dir"
  if [ -f "$web_dir/index.ts" ]; then
    echo "setup-runtime: keeping existing web extension $web_dir/index.ts" >&2
    return 0
  fi
  if [ -f "$web_dir/node_modules/pi-web-access/index.ts" ]; then
    echo "setup-runtime: official pi-web-access already present" >&2
    return 0
  fi
  command -v npm >/dev/null 2>&1 || die "npm is required for --web"
  echo "setup-runtime: installing npm:pi-web-access into $web_dir" >&2
  npm install --prefix "$web_dir" --no-package-lock --no-save "pi-web-access@${ARIS_WEB_VERSION:-0.34.0}" \
    || die "pi-web-access installation failed"
}

runtime_record() {
  echo "ARIS runtime record"
  echo "  project_root=$ARIS_ROOT"
  echo "  runtime_dir=$RUNTIME_DIR"
  echo "  python=$VENV_PY"
  echo "  python_index=$PIP_INDEX"
  "$VENV_PY" - <<'PY'
import importlib.metadata
for name in ("requests", "numpy", "matplotlib", "seaborn", "pypdf", "PyMuPDF"):
    try:
        print(f"  python_package={name}=={importlib.metadata.version(name)}")
    except importlib.metadata.PackageNotFoundError:
        print(f"  python_package={name}==MISSING")
PY
  if [ -f "$RUNTIME_DIR/web/node_modules/pi-web-access/package.json" ]; then
    "$PYTHON_CMD" - "$RUNTIME_DIR/web/node_modules/pi-web-access/package.json" <<'PY'
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
data = json.loads(p.read_text(encoding="utf-8"))
print(f"  npm_package=pi-web-access@{data.get('version', 'unknown')}")
print("  npm_license=" + str(data.get("license", "unknown")))
PY
  fi
  if [ -n "$POPPLER_PACKAGES" ]; then
    echo "  poppler_source=$POPPLER_SOURCE"
    echo "  poppler_packages=$POPPLER_PACKAGES"
    echo "  poppler_license=Ubuntu archive package metadata in the downloaded .deb files"
  fi
  if [ -f "$RUNTIME_DIR/bin/latexmk" ]; then
    echo "  latexmk_source=project-local official CTAN executable at $RUNTIME_DIR/bin/latexmk"
  fi
}

ensure_venv
ensure_python_packages

if [ "$DO_WEB" = 1 ] && [ "$CHECK_ONLY" = 0 ]; then
  ensure_web
fi
if [ "$DO_PAPER" = 1 ] && [ "$CHECK_ONLY" = 0 ]; then
  # TeX is deliberately a host prerequisite. The project setup may prepare
  # Poppler, but it never installs texlive-full or changes apt/system state.
  if ! command -v pdflatex >/dev/null 2>&1 || ! command -v bibtex >/dev/null 2>&1; then
    echo "setup-runtime: paper prerequisite missing: install pdflatex and bibtex on the host; this script does not install texlive-full." >&2
    PAPER_INCOMPLETE=1
  fi
  if ! command -v latexmk >/dev/null 2>&1 && [ ! -x "$RUNTIME_DIR/bin/latexmk" ]; then
    mkdir -p "$RUNTIME_DIR/bin"
    curl --fail --location --silent --show-error --max-time 180 https://tug.ctan.org/support/latexmk/latexmk.pl -o "$RUNTIME_DIR/bin/latexmk.tmp" || die 'could not obtain the official CTAN latexmk script'
    chmod +x "$RUNTIME_DIR/bin/latexmk.tmp"
    mv "$RUNTIME_DIR/bin/latexmk.tmp" "$RUNTIME_DIR/bin/latexmk"
  fi
  if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftotext >/dev/null 2>&1; then
    ensure_poppler
  fi
fi

if [ "$CHECK_ONLY" = 1 ]; then
  check_args=(--root "$ARIS_ROOT" --json)
  [ "$DO_PAPER" = 1 ] && check_args+=(--paper)
  "$PYTHON_CMD" "$SCRIPT_DIR/runtime-check.py" "${check_args[@]}"
else
  runtime_record
fi
if [ "$PAPER_INCOMPLETE" = 1 ]; then
  exit 2
fi

