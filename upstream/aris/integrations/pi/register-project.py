#!/usr/bin/env python3
"""Explicit project registration for the read-only observer. No research state writes."""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile


def register(config, root, project_id, name, goal):
    config = Path(config).resolve()
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('project must be a directory')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', project_id):
        raise ValueError('project id must use letters, numbers, dot, underscore or hyphen')
    data = json.loads(config.read_text()) if config.exists() else {'projects': []}
    projects = data if isinstance(data, list) else data.get('projects')
    if not isinstance(projects, list):
        raise ValueError('registration must contain a projects array')
    existing = next((entry for entry in projects if entry.get('id') == project_id), None)
    if existing and (config.parent / existing['root']).resolve() != root:
        raise ValueError('project id already belongs to another directory')
    entry = {'id': project_id, 'name': name or project_id,
             'root': os.path.relpath(root, config.parent), 'goal': goal,
             'supervisor': 'Pi / ARIS + independent reviewer'}
    if existing:
        existing.update(entry)
    else:
        projects.append(entry)
    config.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=config.name + '.', dir=config.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(data, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, config)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return entry


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--name', default='')
    parser.add_argument('--goal', default='')
    args = parser.parse_args()
    try:
        print(json.dumps(register(args.config, args.root, args.id, args.name, args.goal), ensure_ascii=False))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, str(error) + '\n')
