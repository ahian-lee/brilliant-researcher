#!/usr/bin/env python3
"""Pi transport adapter: retain upstream behavior and expose its threadId in text.
pi-mcp-extension 1.5 only forwards content, dropping structuredContent. Without
this, ARIS loses reviewer memory and starts a new thread every round.
"""
import importlib.util
import json
from pathlib import Path

source=Path(__file__).resolve().parents[2]/'mcp-servers/codex-exec/server.py'
spec=importlib.util.spec_from_file_location('aris_codex_exec',source)
upstream=importlib.util.module_from_spec(spec)
spec.loader.exec_module(upstream)
original=upstream.tool_result

def pi_tool_result(request_id,outcome):
    response=original(request_id,outcome)
    result=response['result']
    structured=result.get('structuredContent')
    if structured:
        # Include exact upstream fields in model-visible content. No summary/verdict changes.
        result['content']=[{'type':'text','text':json.dumps(structured,ensure_ascii=False)}]
    return response

upstream.tool_result=pi_tool_result
if __name__=='__main__':
    upstream.main()
