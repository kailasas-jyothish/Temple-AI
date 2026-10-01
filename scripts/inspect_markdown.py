import os

DURGA_DIR = r"C:\Users\GD\Downloads\Durga Saptashati"
md_dev = os.path.join(DURGA_DIR, "(For Projecting) Shri Durga Saptashati - Devanagari.md")
md_eng = os.path.join(DURGA_DIR, "(For Projecting) Shri Durga Saptashati - English.md")

with open(md_dev, "r", encoding="utf-8", errors="replace") as f:
    dev_lines = f.readlines()

with open(md_eng, "r", encoding="utf-8", errors="replace") as f:
    eng_lines = f.readlines()

print("--- DEVANAGARI AROUND LINE 195 ---")
for i in range(190, 270):
    if i < len(dev_lines):
        print(f"{i+1}: {repr(dev_lines[i])}")

print("\n--- DEVANAGARI NEXT SECTION ---")
# find next header starting with #
for i in range(250, len(dev_lines)):
    line = dev_lines[i]
    if line.startswith("# ") and "kavacha" not in line.lower():
        print(f"Next section at line {i+1}: {line}")
        # print previous few lines
        for j in range(max(190, i-15), i+2):
            print(f"  {j+1}: {repr(dev_lines[j])}")
        break

print("\n--- ENGLISH AROUND LINE 195 ---")
for i in range(190, 270):
    if i < len(eng_lines):
        print(f"{i+1}: {repr(eng_lines[i])}")

for i in range(250, len(eng_lines)):
    line = eng_lines[i]
    if line.startswith("# ") and "kavacha" not in line.lower():
        print(f"Next English section at line {i+1}: {line}")
        for j in range(max(190, i-15), i+2):
            print(f"  {j+1}: {repr(eng_lines[j])}")
        break
