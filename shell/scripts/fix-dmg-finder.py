#!/usr/bin/env python3
# actdsh dmg 后处理：把 electron-builder/dmgbuild 输出的 .DS_Store 改写为 Finder 26.2+/27
# 兼容的「新格式」（背景放入 .background/ 目录 + icvp 别名 + pBB0/pBBk 书签 + 隐藏属性）。
# 背景：macOS 26.2 起 Finder 不再渲染 dmgbuild 旧格式的背景图（实测 27 亦然；Keka 等新格式正常）。
# 流程：UDZO → UDRW 临时镜像 → 改写布局 → 回转 UDZO 覆盖原文件。
# 依赖：ds_store / mac_alias python 模块（用 electron-builder toolset 自带捆绑 python 运行）。
# 用法: <bundled-python> fix-dmg-finder.py <dmg路径>
import os
import re
import shutil
import subprocess
import sys
import tempfile


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main():
    dmg = os.path.abspath(sys.argv[1])
    if not os.path.isfile(dmg):
        sys.exit(f"not a file: {dmg}")

    tmpdir = tempfile.mkdtemp(prefix="actdsh-dmg-fix-")
    rw_path = os.path.join(tmpdir, "layout-rw.dmg")

    conv1 = run(["hdiutil", "convert", dmg, "-format", "UDRW", "-o", rw_path])
    if conv1.returncode != 0:
        sys.exit(f"convert UDRW failed: {conv1.stdout}\n{conv1.stderr}")

    attach = run(["hdiutil", "attach", "-noverify", "-noautoopen", "-readwrite", rw_path])
    if attach.returncode != 0:
        sys.exit(f"attach failed: {attach.stdout}\n{attach.stderr}")

    device = None
    m = re.search(r"^(/dev/\w+)", attach.stdout, re.M)
    if m:
        device = m.group(1)
    volume = None
    for line in attach.stdout.splitlines():
        mm = re.search(r"\s+(/Volumes/.+?)\s*$", line)
        if mm:
            volume = mm.group(1).strip()
            break
    if not volume:
        sys.exit(f"cannot find mount point:\n{attach.stdout}")

    try:
        from ds_store import DSStore
        from mac_alias import Alias, Bookmark

        ds_path = os.path.join(volume, ".DS_Store")

        old = DSStore.open(ds_path, "r")
        window = None
        icon_size = 72.0
        ilocs = {}
        for e in old:
            if e.code == b"bwsp":
                window = e.value
            elif e.code == b"icvp":
                icon_size = e.value.get("iconSize", 72.0)
            elif e.code == b"Iloc" and e.filename != ".":
                # 根条目上的 Iloc 是误写（早期版本）；不保留。
                # 负坐标（读回为超大无符号值）来自早期原始字节方案，会毒化整个
                # .DS_Store 使 Finder 27 回退自动排布——一律不保留。
                v = e.value
                if isinstance(v, tuple) and 0 <= v[0] < 10000 and 0 <= v[1] < 10000:
                    ilocs[e.filename] = v
        old.close()
        if window is None:
            window = {
                "ShowStatusBar": False,
                "WindowBounds": "{{100, 100}, {680, 480}}",
                "ContainerShowSidebar": False,
                "PreviewPaneVisibility": False,
                "SidebarWidth": 180,
                "ShowTabView": False,
                "ShowToolbar": False,
                "ShowPathbar": False,
                "ShowSidebar": False,
            }

        bg_dir = os.path.join(volume, ".background")
        os.makedirs(bg_dir, exist_ok=True)
        bg_dst = None
        for cand in (".background.tiff", ".background.png"):
            src = os.path.join(volume, cand)
            if os.path.isfile(src):
                dst = os.path.join(bg_dir, cand.split(".", 1)[1])
                shutil.move(src, dst)
                bg_dst = dst
                break
        if bg_dst is None:
            for name in ("background.tiff", "background.png"):
                p = os.path.join(bg_dir, name)
                if os.path.isfile(p):
                    bg_dst = p
                    break
        if bg_dst is None:
            sys.exit("no background file found on volume")

        icvp = {
            "viewOptionsVersion": 1,
            "backgroundType": 2,
            "backgroundColorRed": 1.0,
            "backgroundColorGreen": 1.0,
            "backgroundColorBlue": 1.0,
            "gridOffsetX": 0.0,
            "gridOffsetY": 0.0,
            "gridSpacing": 100.0,
            "arrangeBy": "none",
            "showIconPreview": False,
            "showItemInfo": False,
            "labelOnBottom": True,
            "textSize": 12.0,
            "iconSize": float(icon_size),
            "scrollPositionX": 0.0,
            "scrollPositionY": 0.0,
            "backgroundImageAlias": Alias.for_file(bg_dst).to_bytes(),
        }
        pbb0 = bytes.fromhex("0000000010d000000400000000000000")

        with DSStore.open(ds_path, "w+") as d:
            d["."]["vSrn"] = ("long", 1)
            d["."]["bwsp"] = window
            d["."]["icvp"] = icvp
            d["."]["pBB0"] = ("blob", pbb0)
            d["."]["pBBk"] = Bookmark.for_file(bg_dst)
            for name, (x, y) in ilocs.items():
                d[name]["Iloc"] = (x, y)
            # 隐藏项（.background/.VolumeIcon.icns/.fseventsd）一律用普通编码器写入
            # 正坐标，整齐排布在默认窗口（900×680）正下方（x=60/160/260, y=780）：
            # 不占窗口可视区（用户视角干净），不使用任何原始字节（避免 Finder 27
            # 拒绝整份 .DS_Store 而回退为自动排布）。
            d[".background"]["Iloc"] = (60, 780)
            d[".VolumeIcon.icns"]["Iloc"] = (160, 780)
            d[".fseventsd"]["Iloc"] = (260, 780)

        subprocess.call(
            ["/usr/bin/SetFile", "-a", "V", bg_dir, os.path.join(volume, ".VolumeIcon.icns"), ds_path]
        )
        subprocess.check_call(("sync", "--file-system", volume))
    finally:
        if device:
            run(["hdiutil", "detach", device])

    final_path = os.path.join(tmpdir, "final.dmg")
    conv2 = run(["hdiutil", "convert", rw_path, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", final_path])
    if conv2.returncode != 0 or not os.path.isfile(final_path):
        sys.exit(f"convert UDZO failed: {conv2.stdout}\n{conv2.stderr}")
    os.replace(final_path, dmg)
    shutil.rmtree(tmpdir, True)
    stale = dmg + ".blockmap"
    if os.path.isfile(stale):
        os.remove(stale)
    print(f"dmg finder layout fixed: {dmg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
