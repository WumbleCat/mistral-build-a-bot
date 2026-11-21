"""Draw a SYNTHETIC top-view rover placeholder for mock runs and smoke tests.

This is a schematic drawing, not a photograph of a real robot.
Usage: python scripts/make_sample_image.py [samples/rover_top_synthetic.png]
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw


def draw(path: Path) -> None:
    img = Image.new("RGB", (960, 720), (226, 222, 214))
    d = ImageDraw.Draw(img)
    # four chunky tyres
    for x, y in ((150, 110), (690, 110), (150, 450), (690, 450)):
        d.rounded_rectangle((x, y, x + 120, y + 170), radius=22, fill=(28, 28, 30))
        for stripe in range(y + 12, y + 165, 20):
            d.line((x + 6, stripe, x + 114, stripe), fill=(70, 70, 74), width=5)
    # green chassis plate
    d.rounded_rectangle((250, 90, 710, 640), radius=18, fill=(46, 150, 82), outline=(30, 104, 56), width=4)
    # white breadboard with LEDs
    d.rectangle((350, 170, 610, 330), fill=(245, 245, 240), outline=(170, 170, 165), width=2)
    for row in range(182, 325, 12):
        for col in range(362, 605, 12):
            d.point((col, row), fill=(120, 120, 120))
    for x, colour in ((400, (230, 40, 40)), (460, (250, 200, 30)), (520, (40, 200, 70))):
        d.ellipse((x, 205, x + 20, 225), fill=colour, outline=(60, 60, 60))
    # blue relay module with two relay blocks and screw terminals
    d.rectangle((370, 400, 590, 540), fill=(24, 72, 160), outline=(14, 44, 104), width=3)
    for x in (392, 492):
        d.rectangle((x, 420, x + 76, 490), fill=(60, 130, 235), outline=(20, 50, 120), width=2)
    for x in range(384, 580, 34):
        d.rectangle((x, 506, x + 24, 530), fill=(70, 160, 90), outline=(30, 80, 45))
    # jumper wires
    for i, colour in enumerate(((220, 40, 40), (250, 190, 20), (30, 30, 30), (240, 240, 240), (255, 130, 0))):
        x = 410 + i * 34
        d.line((x, 330, x - 14, 365, x + 10, 400), fill=colour, width=4, joint="curve")
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print(f"wrote {path}")


if __name__ == "__main__":
    draw(Path(sys.argv[1] if len(sys.argv) > 1 else "samples/rover_top_synthetic.png"))
