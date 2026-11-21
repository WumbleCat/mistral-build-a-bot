"""Start the Robot BOM web app.

Run this file (for example with the green Run button in PyCharm) to start the server and
open the app in your browser. With arguments it behaves like the ``robot-bom`` CLI:

    python main.py                      # web app
    python main.py analyze photo.jpg    # same as: robot-bom analyze photo.jpg
"""

import sys

from robot_bom.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["serve", "--open"]))
