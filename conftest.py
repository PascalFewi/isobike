"""Put the repo root on sys.path so `build.*` and `testdata.gen.*` import cleanly.

The spec fixes the top-level directory names (`build/`, `testdata/`), and `build`
collides with the PyPI package of the same name. We never invoke `python -m build`,
so the shadowing is harmless -- but it is the reason this file is explicit rather
than relying on implicit namespace-package discovery.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
