import io
from PIL import Image
from app.services.chat_attachment_read import MAX_EDGE_PX, MAX_OUT_BYTES, prepare_image, text_body

def _jpeg(size, orientation=None, mode="RGB"):
    im = Image.new(mode, size, (200, 30, 30))
    buf = io.BytesIO()
    if orientation:
        exif = Image.Exif(); exif[0x0112] = orientation
        im.save(buf, format="JPEG", exif=exif.tobytes())
    else:
        im.save(buf, format="JPEG")
    return buf.getvalue()

def test_big_phone_photo_is_downscaled_long_edge():
    out = prepare_image(_jpeg((3000, 4000)))
    assert out is not None and out.mime_type == "image/jpeg"
    assert max(out.width, out.height) <= MAX_EDGE_PX and len(out.data) <= MAX_OUT_BYTES

def test_exif_orientation_is_applied_and_exif_dropped():
    raw = _jpeg((300, 100), orientation=6)  # rotated 90°: the stored 300x100 must come out as 100x300
    out = prepare_image(raw)
    assert (out.width, out.height) == (100, 300)
    assert b"Exif" not in out.data and b"GPS" not in out.data

def test_bomb_or_garbage_gives_none_not_crash():
    assert prepare_image(b"not an image at all") is None
    assert prepare_image(b"\x00" * 10) is None

def test_text_only_within_200kb_and_known_extension():
    assert text_body(b"hello", "txt") == "hello"
    assert text_body(b"x" * (200 * 1024 + 1), "txt") is None
    assert text_body(b"hello", "exe") is None
    assert text_body(b"\xff\xfe", "txt") is None
