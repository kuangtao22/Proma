#!/usr/bin/env python3
"""将明确列出的图片按原比例排成有界 PNG 联系表。"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import warnings

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ImportError:
    print("错误：缺少 Pillow，请使用已具备 Pillow 的 Python 环境。", file=sys.stderr)
    raise SystemExit(2)


# 这些上限同时约束输入解码、单格缩放和最终 RGBA 画布的峰值内存。
MAX_IMAGE_COUNT = 64
MAX_PATH_LENGTH = 4096
MAX_DIMENSION = 8192
MAX_SOURCE_PIXELS = 20_000_000
MAX_CELL_PIXELS = 8_000_000
MAX_CANVAS_PIXELS = 32_000_000
MAX_CANVAS_SIDE = 32_768
EXIF_ORIENTATION_TAG = 274
TRANSPOSED_EXIF_ORIENTATIONS = {2, 3, 4, 5, 6, 7, 8}
SWAPPED_EXIF_ORIENTATIONS = {5, 6, 7, 8}

# 让 Pillow 在解码前沿用同一输入预算，不接受只靠警告继续处理的超大图片。
Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS


class ContactSheetError(Exception):
    """表示可向调用方直接说明的输入或资源约束错误。"""


class SourceMetadata:
    """保存预检得到的小型元数据，避免在内存中保留全部原图。"""

    def __init__(
        self,
        path: Path,
        encoded_width: int,
        encoded_height: int,
        original_width: int,
        original_height: int,
        orientation: int,
    ) -> None:
        self.path = path
        self.encoded_width = encoded_width
        self.encoded_height = encoded_height
        self.original_width = original_width
        self.original_height = original_height
        self.orientation = orientation


def positive_integer(value: str) -> int:
    """解析正整数参数；非法值交由 argparse 输出统一错误。"""
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("必须是正整数") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("必须是正整数")
    return parsed


def parse_arguments() -> argparse.Namespace:
    """解析显式图片列表及固定的简洁布局参数。"""
    parser = argparse.ArgumentParser(description="按原比例生成 PNG 联系表")
    parser.add_argument("--output", required=True, help="目标 PNG；已存在时拒绝覆盖")
    parser.add_argument("--columns", type=positive_integer, default=2, help="列数，默认 2")
    parser.add_argument("--cell-width", type=positive_integer, default=480, help="格宽，默认 480")
    parser.add_argument("--cell-height", type=positive_integer, help="格高；缺省按首图方向比例推导")
    parser.add_argument("inputs", nargs="+", help="按顺序明确列出的输入图片")
    return parser.parse_args()


def resolve_paths(output_value: str, input_values: list[str]) -> tuple[Path, list[Path]]:
    """解析并验证输出与输入路径，不扫描目录或隐式扩展文件列表。"""
    if len(input_values) > MAX_IMAGE_COUNT:
        raise ContactSheetError(f"图片数量不能超过 {MAX_IMAGE_COUNT}")
    for path_value in [output_value, *input_values]:
        if len(path_value) > MAX_PATH_LENGTH:
            raise ContactSheetError(f"路径长度不能超过 {MAX_PATH_LENGTH} 个字符")

    # absolute 只规范化文本路径而不跟随末端链接，确保悬空链接也算已有输出。
    output_entry_path = Path(os.path.abspath(Path(output_value).expanduser()))
    if os.path.lexists(output_entry_path):
        raise ContactSheetError(f"输出文件已存在：{output_entry_path}")
    output_path = output_entry_path.resolve(strict=False)
    if output_path.suffix.lower() != ".png":
        raise ContactSheetError("输出文件必须使用 .png 扩展名")
    if not output_path.parent.is_dir():
        raise ContactSheetError(f"输出目录不存在：{output_path.parent}")

    # 这里只解析调用方列出的路径；不存在、目录和输出别名都明确拒绝。
    input_paths: list[Path] = []
    for input_value in input_values:
        try:
            input_path = Path(input_value).expanduser().resolve(strict=True)
        except FileNotFoundError as error:
            raise ContactSheetError(f"输入图片不存在：{input_value}") from error
        if not input_path.is_file():
            raise ContactSheetError(f"输入路径不是文件：{input_path}")
        if input_path == output_path:
            raise ContactSheetError(f"输出文件不能与输入文件相同：{output_path}")
        input_paths.append(input_path)
    return output_path, input_paths


def inspect_source(path: Path) -> SourceMetadata:
    """只保留图片尺寸与 EXIF 方向，并用 verify 提前发现损坏输入。"""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                encoded_width, encoded_height = source.size
                if encoded_width <= 0 or encoded_height <= 0:
                    raise ContactSheetError(f"图片尺寸无效：{path}")
                if encoded_width * encoded_height > MAX_SOURCE_PIXELS:
                    raise ContactSheetError(
                        f"输入图片超过 {MAX_SOURCE_PIXELS} 像素预算：{path}"
                    )
                orientation = int(source.getexif().get(EXIF_ORIENTATION_TAG, 1))
            # Pillow 要求 verify 紧跟 open；读取 EXIF 会移动部分格式的内部游标。
            with Image.open(path) as verification_source:
                verification_source.verify()
    except ContactSheetError:
        raise
    except (
        OSError,
        RuntimeError,
        ValueError,
        SyntaxError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
    ) as error:
        raise ContactSheetError(f"无法读取图片：{path}") from error
    except Image.DecompressionBombWarning as error:
        raise ContactSheetError(f"输入图片超过 {MAX_SOURCE_PIXELS} 像素预算：{path}") from error

    if orientation in SWAPPED_EXIF_ORIENTATIONS:
        original_width, original_height = encoded_height, encoded_width
    else:
        original_width, original_height = encoded_width, encoded_height
    return SourceMetadata(
        path=path,
        encoded_width=encoded_width,
        encoded_height=encoded_height,
        original_width=original_width,
        original_height=original_height,
        orientation=orientation,
    )


def calculate_scaled_size(
    source_width: int,
    source_height: int,
    cell_width: int,
    cell_height: int,
) -> tuple[int, int]:
    """计算不裁剪的 contain 尺寸，始终保持源图宽高比。"""
    if source_width * cell_height >= source_height * cell_width:
        scaled_width = cell_width
        scaled_height = max(1, (source_height * cell_width) // source_width)
    else:
        scaled_height = cell_height
        scaled_width = max(1, (source_width * cell_height) // source_height)
    return scaled_width, scaled_height


def validate_layout(
    image_count: int,
    requested_columns: int,
    cell_width: int,
    cell_height: int,
) -> tuple[int, int, int, int]:
    """在分配画布前验证格子、边长和总像素预算。"""
    if requested_columns > MAX_IMAGE_COUNT:
        raise ContactSheetError(f"列数不能超过 {MAX_IMAGE_COUNT}")
    if cell_width > MAX_DIMENSION or cell_height > MAX_DIMENSION:
        raise ContactSheetError(f"单格边长不能超过 {MAX_DIMENSION}")
    if cell_width * cell_height > MAX_CELL_PIXELS:
        raise ContactSheetError(f"单格超过 {MAX_CELL_PIXELS} 像素预算")

    columns = min(requested_columns, image_count)
    rows = math.ceil(image_count / columns)
    canvas_width = columns * cell_width
    canvas_height = rows * cell_height
    if canvas_width > MAX_CANVAS_SIDE or canvas_height > MAX_CANVAS_SIDE:
        raise ContactSheetError(f"画布边长不能超过 {MAX_CANVAS_SIDE}")
    if canvas_width * canvas_height > MAX_CANVAS_PIXELS:
        raise ContactSheetError(f"画布像素预算不能超过 {MAX_CANVAS_PIXELS}")
    return columns, rows, canvas_width, canvas_height


def publish_png(canvas: Image.Image, output_path: Path) -> None:
    """先写同目录临时 PNG，再用硬链接原子发布且绝不覆盖已有目标。"""
    temporary_descriptor, temporary_value = tempfile.mkstemp(
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        dir=output_path.parent,
    )
    os.close(temporary_descriptor)
    temporary_path = Path(temporary_value)
    try:
        canvas.save(temporary_path, format="PNG", optimize=True)
        with temporary_path.open("rb") as temporary_file:
            os.fsync(temporary_file.fileno())
        try:
            os.link(temporary_path, output_path)
        except FileExistsError as error:
            raise ContactSheetError(f"输出文件已存在：{output_path}") from error
        except OSError as error:
            raise ContactSheetError(f"无法原子发布输出文件：{output_path}") from error
    finally:
        temporary_path.unlink(missing_ok=True)


def build_contact_sheet(
    output_path: Path,
    sources: list[SourceMetadata],
    requested_columns: int,
    cell_width: int,
    requested_cell_height: int | None,
) -> dict[str, object]:
    """串行解码每帧并合成白底 PNG，返回有界几何验收数据。"""
    first_source = sources[0]
    cell_height = requested_cell_height or max(
        1,
        round(cell_width * first_source.original_height / first_source.original_width),
    )
    columns, rows, canvas_width, canvas_height = validate_layout(
        len(sources), requested_columns, cell_width, cell_height
    )
    frame_results: list[dict[str, object]] = []
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (255, 255, 255, 255))
    try:
        for index, metadata in enumerate(sources):
            scaled_width, scaled_height = calculate_scaled_size(
                metadata.original_width,
                metadata.original_height,
                cell_width,
                cell_height,
            )
            cell_x = (index % columns) * cell_width
            cell_y = (index // columns) * cell_height
            target_x = cell_x + ((cell_width - scaled_width) // 2)
            target_y = cell_y + ((cell_height - scaled_height) // 2)
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(metadata.path) as source:
                        current_orientation = int(source.getexif().get(EXIF_ORIENTATION_TAG, 1))
                        if source.size != (metadata.encoded_width, metadata.encoded_height):
                            raise ContactSheetError(f"图片在处理期间发生变化：{metadata.path}")
                        if current_orientation != metadata.orientation:
                            raise ContactSheetError(f"图片在处理期间发生变化：{metadata.path}")
                        with ImageOps.exif_transpose(source) as oriented:
                            if oriented.size != (metadata.original_width, metadata.original_height):
                                raise ContactSheetError(f"图片在处理期间发生变化：{metadata.path}")
                            with oriented.convert("RGBA") as rgba_source:
                                with rgba_source.resize(
                                    (scaled_width, scaled_height),
                                    Image.Resampling.LANCZOS,
                                ) as resized:
                                    canvas.alpha_composite(resized, (target_x, target_y))
            except ContactSheetError:
                raise
            except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
                raise ContactSheetError(
                    f"输入图片超过 {MAX_SOURCE_PIXELS} 像素预算：{metadata.path}"
                ) from error
            except (OSError, RuntimeError, ValueError, SyntaxError, UnidentifiedImageError) as error:
                raise ContactSheetError(f"无法读取图片：{metadata.path}") from error

            frame_results.append({
                "input": str(metadata.path),
                "encodedWidth": metadata.encoded_width,
                "encodedHeight": metadata.encoded_height,
                "originalWidth": metadata.original_width,
                "originalHeight": metadata.original_height,
                "scaledWidth": scaled_width,
                "scaledHeight": scaled_height,
                "x": target_x,
                "y": target_y,
                "exifTransposed": metadata.orientation in TRANSPOSED_EXIF_ORIENTATIONS,
            })
        publish_png(canvas, output_path)
    finally:
        canvas.close()

    return {
        "output": str(output_path),
        "canvasWidth": canvas_width,
        "canvasHeight": canvas_height,
        "columns": columns,
        "rows": rows,
        "cellWidth": cell_width,
        "cellHeight": cell_height,
        "frames": frame_results,
    }


def main() -> int:
    """执行预检、合成与原子发布，并只在成功时输出单行 JSON。"""
    arguments = parse_arguments()
    try:
        output_path, input_paths = resolve_paths(arguments.output, arguments.inputs)
        sources = [inspect_source(path) for path in input_paths]
        result = build_contact_sheet(
            output_path=output_path,
            sources=sources,
            requested_columns=arguments.columns,
            cell_width=arguments.cell_width,
            requested_cell_height=arguments.cell_height,
        )
    except ContactSheetError as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
