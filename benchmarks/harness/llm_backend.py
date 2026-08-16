#!/usr/bin/env python3
"""LLM backend abstraction for Memory Lane benchmark harness.

Provides a single llm_call() that routes to one of two backends:

  backend='local'  -> Ollama (zero cost, runs on user's machine)
  backend='deepseek'  -> DeepSeek / user's main provider (tiny token cost,
                      much stronger model)

This is the "install-time three paths" architecture in miniature:
  - local model only
  - main/provider model only
  - both (local default, provider for heavy jobs)

DeepSeek credentials are read from the environment: DEEPSEEK_API_KEY,
DEEPSEEK_BASE_URL, and DEEPSEEK_MODEL. Falls back to local Ollama when no key is set.
"""
import json
import urllib.request
import urllib.error
import os
import re
from pathlib import Path

# Local Ollama endpoint
OLLAMA = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434/api/generate")


def _load_deepseek_config():
    """Read DeepSeek credentials from environment variables (env-only, no local config)."""
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
    default_model = os.environ.get("DEEPSEEK_MODEL", "deepseek/deepseek-v4-flash")
    return {"api_key": key, "base_url": base, "default_model": default_model}


def llm_call(prompt, backend="local", model=None, max_tokens=800, timeout=180):
    """Single LLM call across backends. Returns response text or __ERROR__."""
    if backend == "local":
        return _ollama(prompt, model or "qwen2.5:3b", max_tokens, timeout)
    elif backend == "deepseek":
        return _deepseek(prompt, model, max_tokens, timeout)
    return f"__ERROR__ unknown backend {backend}"


def _ollama(prompt, model, max_tokens, timeout):
    payload = json.dumps({
        "model": model, "prompt": prompt, "stream": False,
        "think": False, "options": {"num_predict": max_tokens}
    })
    try:
        p = __import__("subprocess").run(
            ["curl", "-s", "--max-time", str(timeout), OLLAMA, "-d", payload],
            capture_output=True, text=True, timeout=timeout + 20)
        d = json.loads(p.stdout)
        return d.get("response", "").strip()
    except Exception as e:
        return f"__ERROR__ {e}"


def _deepseek(prompt, model, max_tokens, timeout):
    cfg = _load_deepseek_config()
    if not cfg["api_key"]:
        return "__ERROR__ no DeepSeek API key found"
    model = model or cfg["default_model"]
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
    }).encode()
    req = urllib.request.Request(
        cfg["base_url"] + "/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["api_key"]},
    )
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        msg = resp["choices"][0]["message"]
        content = msg.get("content") or ""
        cost = resp.get("usage", {}).get("cost", 0)
        return f"{content.strip()}|||cost={cost}"
    except urllib.error.HTTPError as e:
        return f"__ERROR__ HTTP {e.code}: {e.read()[:200]}"
    except Exception as e:
        return f"__ERROR__ {e}"


def strip_cost(response):
    """Split 'text|||cost=X' back into (text, cost). Returns (text, None) if no cost."""
    if "|||cost=" in response:
        text, _, cost = response.rpartition("|||cost=")
        try:
            return text.strip(), float(cost)
        except ValueError:
            return text.strip(), None
    return response, None
