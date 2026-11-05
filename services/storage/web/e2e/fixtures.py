#!/usr/bin/env python3
"""Generate the sample folder the smoke and cluster tests upload.

Usage: python3 -I fixtures.py OUT_DIR

Creates OUT_DIR/Trip notes/ with an image, a PDF, Markdown, Go code, a
video, a docx, CSV, JSON and a ZIP. Needs ImageMagick (magick), ffmpeg and
chromium on PATH; everything else is the standard library.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

out = os.path.join(sys.argv[1], "Trip notes")
os.makedirs(out, exist_ok=True)

def run(*cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# Image: a 1600x1000 gradient with a label, so the thumbnail and zoom show something.
run("magick", "-size", "1600x1000", "gradient:#2956b8-#93b6ff", "-gravity", "center",
    "-pointsize", "96", "-fill", "white", "-annotate", "0", "Lake Bled, 06:40",
    os.path.join(out, "lake.jpg"))

# PDF with real, searchable text, printed by headless Chromium.
html = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False)
html.write("""<!doctype html><meta charset=utf-8><style>body{font:16px/1.5 sans-serif;margin:48px}h1{font-size:28px}</style>
<h1>Itinerary</h1><p>Day 1: Ljubljana to Bled by train, 55 minutes.</p><p>Day 2: Vintgar gorge walk, about 4 km.</p>
<p style="page-break-before:always">Day 3: Bohinj lake and the Savica waterfall.</p><p>Budget: 410 euros for three nights.</p>""")
html.close()
chromium = shutil.which("chromium") or shutil.which("chromium-browser") or "chromium"
run(chromium, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={os.path.join(out, 'itinerary.pdf')}", "file://" + html.name)
os.unlink(html.name)

with open(os.path.join(out, "packing list.md"), "w") as f:
    f.write("""# Packing list

Things to bring for **three nights** in the mountains.

- Rain jacket
- Walking boots
- Train tickets (printed)

| Item | Who |
|---|---|
| Stove | Alice |
| Map | Bob |

```go
fmt.Println("see you at the station")
```

<script>alert("this stays text")</script>

[Bled tourist office](https://www.bled.si/en/)
""")

with open(os.path.join(out, "budget.go"), "w") as f:
    f.write("""package trip

import "fmt"

// Budget adds up what the trip costs per person.
func Budget(nights int, perNight float64, people int) string {
	total := float64(nights) * perNight
	return fmt.Sprintf("%.2f each", total/float64(people))
}
""")

# Video: 4 seconds, H.264 + AAC in MP4, which every browser plays.
run("ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", os.path.join(out, "drone.mp4"))

# A minimal but valid Word document.
paras = ["Dear Alice,", "Thanks for organising the trip to Bled.", "The deposit of 120 euros is paid.", "Bob"]
body = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{p}</w:t></w:r></w:p>" for p in paras)
with zipfile.ZipFile(os.path.join(out, "thank you letter.docx"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""")
    z.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""")
    z.writestr("word/document.xml", f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>""")

with open(os.path.join(out, "expenses.csv"), "w") as f:
    f.write("date,what,euros\n2026-06-01,train,24.50\n2026-06-01,hostel,135\n2026-06-02,gorge ticket,10\n2026-06-03,boat,12\n")

with open(os.path.join(out, "route.json"), "w") as f:
    json.dump({"from": "Ljubljana", "to": "Bled", "stops": ["Radovljica", "Lesce"], "minutes": 55}, f)

with zipfile.ZipFile(os.path.join(out, "maps.zip"), "w") as z:
    z.writestr("maps/bled.txt", "Bled lake loop, 6 km\n")
    z.writestr("maps/bohinj.txt", "Bohinj east shore\n")

print(out)
