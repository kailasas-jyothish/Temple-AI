import numpy as np
from PIL import Image

sample_path = r"C:\Users\GD\Downloads\Durga Saptashati\Elements\Sample Image of Slide.png"
empty_path = r"C:\Users\GD\Downloads\Durga Saptashati\Elements\Empty Slide (without text).png"

im_sample = Image.open(sample_path).convert("RGB")
im_empty = Image.open(empty_path).convert("RGB")

arr_s = np.array(im_sample, dtype=np.float32)
arr_e = np.array(im_empty, dtype=np.float32)

diff = np.max(np.abs(arr_s - arr_e), axis=2)

# Row-wise diff sum
row_diff = np.sum(diff > 25, axis=1)
# Column-wise diff sum
col_diff = np.sum(diff > 25, axis=0)

# Print rows that have high diff (text lines)
print("Rows with text (diff > 25 count > 50):")
in_block = False
start_y = 0
for y, val in enumerate(row_diff):
    if val > 50 and not in_block:
        in_block = True
        start_y = y
    elif val <= 50 and in_block:
        in_block = False
        print(f"Block Y: {start_y} to {y} (height: {y - start_y}), max pixel diff count: {np.max(row_diff[start_y:y])}")
if in_block:
    print(f"Block Y: {start_y} to {len(row_diff)} (height: {len(row_diff) - start_y})")

print("\nCols with text:")
in_block = False
start_x = 0
for x, val in enumerate(col_diff):
    if val > 50 and not in_block:
        in_block = True
        start_x = x
    elif val <= 50 and in_block:
        in_block = False
        print(f"Block X: {start_x} to {x} (width: {x - start_x}), max pixel diff count: {np.max(col_diff[start_x:x])}")
if in_block:
    print(f"Block X: {start_x} to {len(col_diff)} (width: {len(col_diff) - start_x})")
