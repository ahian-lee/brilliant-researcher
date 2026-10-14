# Sourced by the launcher; existing dependencies only, no installation.
ARIS_LOCAL_RUNTIME="${ARIS_RUNTIME_DIR:-$ARIS_REPO/.aris/runtime}"
for ARIS_RUNTIME_BIN in "$ARIS_LOCAL_RUNTIME/python/bin" "$ARIS_LOCAL_RUNTIME/bin" "$ARIS_LOCAL_RUNTIME/poppler/usr/bin"; do
  [ ! -d "$ARIS_RUNTIME_BIN" ] || PATH="$ARIS_RUNTIME_BIN:$PATH"
done
ARIS_POPPLER_LIB="$ARIS_LOCAL_RUNTIME/poppler/usr/lib/x86_64-linux-gnu"
if [ -d "$ARIS_POPPLER_LIB" ]; then
  export LD_LIBRARY_PATH="$ARIS_POPPLER_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export PATH
