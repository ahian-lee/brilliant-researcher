#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('register_project', Path(__file__).with_name('register-project.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RegistrationTests(unittest.TestCase):
    def test_add_update_preserve_and_refuse_other_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / '路径 with spaces'
            project.mkdir()
            other = root / 'other'
            other.mkdir()
            config = root / 'view/projects.json'
            module.register(config, project, 'study', '研究', 'Question')
            data = json.loads(config.read_text())
            self.assertEqual((config.parent / data['projects'][0]['root']).resolve(), project)
            data['otherSetting'] = 'keep'
            config.write_text(json.dumps(data))
            module.register(config, project, 'study', 'Renamed', 'New question')
            self.assertEqual(json.loads(config.read_text())['otherSetting'], 'keep')
            self.assertEqual(len(json.loads(config.read_text())['projects']), 1)
            with self.assertRaises(ValueError):
                module.register(config, other, 'study', 'Wrong', '')
            self.assertEqual(json.loads(config.read_text())['projects'][0]['name'], 'Renamed')

    def test_bad_id_and_malformed_config_do_not_replace_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / 'projects.json'
            config.write_text('{bad')
            with self.assertRaises(ValueError):
                module.register(config, root, 'valid', '', '')
            self.assertEqual(config.read_text(), '{bad')
            with self.assertRaises(ValueError):
                module.register(root / 'new.json', root, '../escape', '', '')
            self.assertFalse((root / 'new.json').exists())


if __name__ == '__main__':
    unittest.main()
