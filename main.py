"""Convenience entry point: ``python main.py analyze photo.jpg`` == ``robot-bom analyze photo.jpg``."""

import sys

from robot_bom.cli import main

if __name__ == "__main__":
    sys.exit(main())
