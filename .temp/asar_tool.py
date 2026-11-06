import json, struct, sys, os

ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"

def read_header():
    with open(ASAR, "rb") as f:
        f.seek(4)
        header_size = struct.unpack("<I", f.read(4))[0]
        f.seek(12)
        json_len = struct.unpack("<I", f.read(4))[0]
        raw = f.read(json_len)
        base = 8 + header_size
    return json.loads(raw.decode("utf-8")), base

def walk(node, prefix=""):
    for name, child in node.get("files", {}).items():
        p = f"{prefix}/{name}" if prefix else name
        if "files" in child:
            yield from walk(child, p)
        else:
            yield p, child

def main():
    header, base = read_header()
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    if mode == "list":
        pat = sys.argv[2].lower() if len(sys.argv) > 2 else ""
        for p, meta in walk(header):
            if pat in p.lower():
                print(p, meta.get("size", ""))
    elif mode == "extract":
        want = sys.argv[2]
        dest = sys.argv[3]
        for p, meta in walk(header):
            if p == want:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(ASAR, "rb") as f:
                    f.seek(base + int(meta["offset"]))
                    data = f.read(meta["size"])
                with open(dest, "wb") as f:
                    f.write(data)
                print(f"extracted {p} ({meta['size']} bytes) -> {dest}")
                return
        print("not found:", want)

if __name__ == "__main__":
    main()
