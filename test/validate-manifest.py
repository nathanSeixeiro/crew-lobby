"""Validate app/app.json with Kiro Crew's own manifest validator. No install, no state change.

Run with the Python that ships inside Kiro Crew (Windows):
  & "$env:LOCALAPPDATA\\Programs\\KiroCrew\\resources\\backend-dist\\kirocrew-backend\\python.exe" test\\validate-manifest.py
"""
import json
import sys
from pathlib import Path

from kiro_crew.apps.manifest import AppManifest
from kiro_crew.apps.permissions import validate_permissions

root = Path(__file__).resolve().parent.parent / "app"
manifest = AppManifest.from_dict(json.loads((root / "app.json").read_text(encoding="utf-8")))
unchecked: list[str] = []
errors = manifest.validate(root, unchecked=unchecked)
perms = validate_permissions(manifest)

for line in errors:
    print("ERROR:", line)
for line in unchecked:
    print("UNCHECKED:", line)
for line in perms.warnings:
    print("PERMISSION WARNING:", line)
for line in perms.denied:
    print("PERMISSION DENIED:", line)

ok = not errors and perms.allowed
print(f"manifest {manifest.name} {manifest.version}: {'OK' if ok else 'INVALID'}")
sys.exit(0 if ok else 1)
