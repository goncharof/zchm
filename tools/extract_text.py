"""Extract the text layer of every digitized book into source/text/<name>.txt with page markers."""
import sys, os, glob
import pypdfium2 as pdfium
src, out = sys.argv[1], sys.argv[2]
for f in sorted(glob.glob(os.path.join(src, "*.pdf"))):
    name = os.path.splitext(os.path.basename(f))[0].replace("ZChM ", "").replace(" ", "_")
    doc = pdfium.PdfDocument(f)
    with open(os.path.join(out, name + ".txt"), "w", encoding="utf-8") as w:
        for i in range(len(doc)):
            w.write(f"\n\n===== PAGE {i+1} =====\n")
            w.write(doc[i].get_textpage().get_text_range().replace("­", "").replace("�", ""))
    print(name, len(doc), "pages")
