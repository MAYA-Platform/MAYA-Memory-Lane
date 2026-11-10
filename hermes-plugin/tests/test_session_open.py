"""Hermes test interpreter; checkout on PYTHONPATH. No real user state."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HOME = tempfile.TemporaryDirectory()
os.environ["HERMES_HOME"] = HOME.name
PLUGIN = Path(__file__).resolve().parents[1] / "memory-lane"
spec = importlib.util.spec_from_file_location("memory_lane_candidate", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
from memory_lane_candidate import open_prefetch as cache


class OpenRecall(unittest.TestCase):
    def test_discoverable_before_provider_initialization(self):
        from hermes_cli.plugins_manifest import parse_manifest_file
        manifest = parse_manifest_file(PLUGIN / "plugin.yaml", PLUGIN, source="user", prefix="")
        self.assertEqual(manifest.kind, "standalone")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def provider(self):
        p = m.MemoryLaneMemoryProvider()
        p._bound_home, p._session_id = self.home, "one"
        p._require_owner_scope = lambda: None
        p._current_prefetch_identity = lambda: "route-A"
        return p

    def test_single_use_and_isolation(self):
        self.assertTrue(cache.store(self.home, "route-A", "one", "private recall"))
        for home, route, sid in [(self.home,"route-B","one"),(self.home,"route-A","two"),(self.home+"other","route-A","one")]:
            self.assertEqual(cache.consume(home, route, sid), "")
        self.assertEqual(cache.consume(self.home, "route-A", "one"), "private recall")
        self.assertEqual(cache.consume(self.home, "route-A", "one"), "")

    def test_expiry_and_size(self):
        with patch.object(cache.time, "time", return_value=100):
            cache.store(self.home, "route-A", "one", "old")
        with patch.object(cache.time, "time", return_value=401):
            self.assertEqual(cache.consume(self.home, "route-A", "one"), "")
        self.assertFalse(cache.store(self.home, "route-A", "one", "x" * cache.MAX_BYTES))

    def test_bound_and_bad_json(self):
        for n in range(12):
            cache.store(self.home, "route-A", str(n), "context")
        root = cache._root(self.home)
        self.assertLessEqual(len(list(root.glob("*.json"))), cache.MAX_ENTRIES)
        path = root / cache._key("route-A", "broken")
        path.write_text("not json")
        self.assertEqual(cache.consume(self.home, "route-A", "broken"), "")
        self.assertFalse(path.exists())

    def test_open_to_fresh_worker(self):
        import hermes_cli.config
        import hermes_constants
        p = self.provider()
        p.initialize = lambda *args, **kwargs: None
        p._format_recent_context = lambda count: "synthetic scoped continuity"
        with patch.object(hermes_cli.config, "load_config_readonly", return_value={"memory":{"provider":"memory-lane"}}), patch.object(hermes_constants,"get_hermes_home",return_value=Path(self.home)), patch.object(m,"MemoryLaneMemoryProvider",return_value=p):
            m._prefetch_on_open(session_id="one", platform="cli", reason="create")
        fresh = self.provider()
        fresh._format_recent_context = lambda *args: self.fail("open recall was not consumed")
        self.assertEqual(fresh.prefetch("continue", session_id="one"), "synthetic scoped continuity")

    def test_miss_falls_back(self):
        p = self.provider()
        p._format_recent_context = lambda *args: "normal retrieval"
        self.assertEqual(p.prefetch("question"), "normal retrieval")

    def test_no_automation_or_messaging(self):
        with patch.object(m,"MemoryLaneMemoryProvider",side_effect=AssertionError("must skip")):
            for platform in ("cron","kanban","a2a","telegram","discord",""):
                m._prefetch_on_open(session_id="one", platform=platform)

    def test_wrong_profile_refused(self):
        p=m.MemoryLaneMemoryProvider(); p._bound_home=self.home
        with patch.object(m,"is_multiplex_active",return_value=True), patch.object(m,"current_secret_scope_home",return_value=self.home+"other"):
            with self.assertRaises(RuntimeError):
                p.prefetch("question")

    def test_no_external_open_keys(self):
        p=self.provider(); p._local_open_only=True
        p._setting=lambda env,key,default,**kw: str(PLUGIN/"__init__.py") if key=="cli" else self.home
        with patch.object(m,"_find_node",return_value="node"), patch.object(m,"get_secret",return_value="synthetic-key"), patch.object(m.subprocess,"run") as run:
            run.return_value.returncode=0; run.return_value.stdout='{"ok":true,"blocks":[]}'
            p._run("recent","5")
            env=run.call_args.kwargs["env"]
            self.assertNotIn("MERGE_API_KEY",env)
            self.assertNotIn("MEMORY_LANE_DECISIONS_URL",env)
            self.assertEqual(env["MEMORY_LANE_MERGE_CONFIG"],os.devnull)


if __name__=="__main__":
    unittest.main()
