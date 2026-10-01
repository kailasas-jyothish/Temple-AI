import numpy as np
from PIL import Image

sample_path = r"C:\Users\GD\Downloads\Durga Saptashati\Elements\Sample Image of Slide.png"
empty_path = r"C:\Users\GD\Downloads\Durga Saptashati\Elements\Empty Slide (without text).png"

im_sample = Image.open(sample_path).convert("RGB")
im_empty = Image.open(empty_path).convert("RGB")

arr_sample = np.array(im_sample, dtype=np.int16)
arr_empty = np.array(im_empty, dtype=np.int16)

diff = np.abs(arr_sample - arr_empty)
# mask where there is a difference (> 15 diff)
diff_mask = np.max(diff, axis=2) > 15

print("Sample size:", im_sample.size)
print("Empty size:", im_empty.size)
print("Diff pixels count:", np.sum(diff_mask))

# Find bounding box of difference
ys, xs = np.where(diff_mask)
if len(ys) > 0:
    min_y, max_y = np.min(ys), np.max(ys)
    min_x, max_x = np.min(xs), np.max(xs)
    print(f"Diff bounding box: X: [{min_x}, {max_x}], Y: [{min_y}, {max_y}]")
    print(f"Width: {max_x - min_x + 1}, Height: {max_y - min_y + 1}")

# Let's save the diff mask or diff image, or crop regions to inspect
# Also let's inspect the colors in the sample image where diff_mask is True
sample_colors = arr_sample[diff_mask]
# Let's see unique or prominent colors
import collections
# round colors to nearest 5 or 10 to see clusters
quantized = [tuple(c // 10 * 10) for c in sample_colors]
counter = collections.Counter(quantized)
print("\nTop 15 color clusters in diff:")
for c, cnt in counter.most_common(15):
    print(f"  Color ~{c}: count {cnt}")

# Let's save a crop of the text area from sample image
crop_img = im_sample.crop((max(0, min_x - 20), max(0, min_y - 20), min(1920, max_x + 20), min(1080, max_y + 20)))
crop_img.save(r"C:\Users\GD\Desktop\GD\Temple-AI\scripts\sample_text_crop.png")
print("Saved sample_text_crop.png")
