"""Local Draw.io XML validation, cell editing, and a basic SVG preview.

Inspired by next-ai-draw-io's editable mxCell workflow; implemented with the
Python standard library. No model, browser, network request, or package install.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET


def parse(text):
    if len(text.encode()) > 2_000_000:
        raise ValueError("Diagram exceeds 2 MiB")
    if "<!" in text or "<?" in text:
        raise ValueError("DTD, entities, XML declarations, and comments are unsupported")
    if not text.lstrip().startswith(("<mxfile", "<mxGraphModel", "<root")):
        text = "<root>" + text + "</root>"
    document = ET.fromstring(text)
    if document.tag == "mxfile":
        pages = document.findall("diagram")
        if len(pages) != 1 or pages[0].find("mxGraphModel") is None:
            raise ValueError("Use one uncompressed mxGraphModel page")
        return document
    output = ET.Element("mxfile", host="OpenCode", compressed="false")
    page = ET.SubElement(output, "diagram", id="page-1", name="Page-1")
    if document.tag == "mxGraphModel":
        page.append(document)
        return output
    graph = ET.SubElement(page, "mxGraphModel", grid="1", page="0")
    graph.append(document)
    return output


def validate(document):
    root = document.find("./diagram/mxGraphModel/root")
    if root is None:
        raise ValueError("Missing mxGraphModel/root")
    if any(child.tag != "mxCell" for child in root):
        raise ValueError("Root children must be mxCell elements")
    cells = list(root)
    ids = [cell.get("id") for cell in cells]
    if None in ids or len(ids) != len(set(ids)):
        raise ValueError("Every cell needs a unique id")
    for identifier, parent in (("0", None), ("1", "0")):
        if identifier not in ids:
            root.insert(0 if identifier == "0" else 1, ET.Element("mxCell", {"id": identifier, **({"parent": parent} if parent else {})}))
    ids = {cell.get("id") for cell in root}
    for cell in root:
        if cell.get("id") == "0" and cell.get("parent") is not None:
            raise ValueError("Root cell 0 must not have a parent")
        if cell.get("id") == "1" and cell.get("parent") != "0":
            raise ValueError("Layer cell 1 must have parent 0")
        for name in ("parent", "source", "target"):
            if cell.get(name) is not None and cell.get(name) not in ids:
                raise ValueError(f"Unknown {name} reference: {cell.get(name)}")
        if cell.get("id") not in ("0", "1") and cell.get("parent") is None:
            raise ValueError("Shapes and edges need a parent")
        if cell.get("vertex") == "1":
            geometry = cell.find("mxGeometry")
            if geometry is None:
                raise ValueError("Every vertex needs mxGeometry")
            for key in ("x", "y", "width", "height"):
                value = float(geometry.get(key, "0"))
                if not -100_000 < value < 100_000:
                    raise ValueError("Geometry must use finite coordinates within 100000")
            if float(geometry.get("width", "0")) <= 0 or float(geometry.get("height", "0")) <= 0:
                raise ValueError("Shapes need positive width and height")
        for node in cell.iter():
            if node.tag not in {"mxCell", "mxGeometry", "mxPoint", "Array", "mxRectangle"}:
                raise ValueError(f"Unsupported XML element: {node.tag}")
            for key, value in node.attrib.items():
                if key.lower().startswith("on") or key.lower() in {"link", "href", "src"}:
                    raise ValueError("Active content and links are not supported")
                if re.search(r"(?:https?:|file:|javascript:|data:|<script|<img|<iframe|image=)", value, re.I):
                    raise ValueError("Remote images and active content are not supported")
    by_id = {cell.get("id"): cell for cell in root}
    for cell in root:
        seen = {cell.get("id")}
        parent = cell.get("parent")
        while parent is not None:
            if parent in seen:
                raise ValueError("Cyclic parent reference")
            seen.add(parent)
            parent = by_id[parent].get("parent")
    return root


def preview(root):
    boxes = {}
    for cell in root:
        if cell.get("vertex") != "1":
            continue
        geometry = cell.find("mxGeometry")
        boxes[cell.get("id")] = [float(geometry.get(key, "0")) for key in ("x", "y", "width", "height")]
    by_id = {cell.get("id"): cell for cell in root}
    for identifier in boxes:
        parent = by_id[identifier].get("parent")
        while parent in boxes:
            geometry = by_id[parent].find("mxGeometry")
            boxes[identifier][0] += float(geometry.get("x", "0"))
            boxes[identifier][1] += float(geometry.get("y", "0"))
            parent = by_id[parent].get("parent")
    left = min([0] + [box[0] - 20 for box in boxes.values()])
    top = min([0] + [box[1] - 20 for box in boxes.values()])
    width = max([300] + [box[0] + box[2] + 20 for box in boxes.values()]) - left
    height = max([160] + [box[1] + box[3] + 20 for box in boxes.values()]) - top
    svg = ET.Element("svg", xmlns="http://www.w3.org/2000/svg", viewBox=f"{left} {top} {width} {height}")
    ET.SubElement(svg, "rect", x=str(left), y=str(top), width=str(width), height=str(height), fill="#ffffff")
    defs = ET.SubElement(svg, "defs")
    marker = ET.SubElement(defs, "marker", id="arrow", markerWidth="8", markerHeight="8", refX="7", refY="3", orient="auto", markerUnits="strokeWidth")
    ET.SubElement(marker, "path", d="M0,0 L0,6 L8,3 z", fill="#475569")
    for cell in root:
        source, target = boxes.get(cell.get("source")), boxes.get(cell.get("target"))
        if cell.get("edge") != "1" or not source or not target:
            continue
        x1, y1 = source[0] + source[2], source[1] + source[3] / 2
        x2, y2 = target[0], target[1] + target[3] / 2
        ET.SubElement(svg, "path", d=f"M{x1},{y1} H{(x1+x2)/2} V{y2} H{x2}", fill="none", stroke="#475569", **{"stroke-width": "2", "marker-end": "url(#arrow)"})
    for cell in root:
        if cell.get("id") not in boxes:
            continue
        x, y, w, h = boxes[cell.get("id")]
        style = dict(item.split("=", 1) for item in cell.get("style", "").split(";") if "=" in item)
        fill = style.get("fillColor", "#e0f2fe")
        if not re.fullmatch(r"#[0-9a-fA-F]{3,8}|[A-Za-z]+", fill):
            fill = "#e0f2fe"
        ET.SubElement(svg, "rect", x=str(x), y=str(y), width=str(w), height=str(h), rx="8", fill=fill, stroke="#475569")
        label = re.sub(r"<[^>]*>", "", cell.get("value", ""))
        text = ET.SubElement(svg, "text", x=str(x+w/2), y=str(y+h/2), fill="#0f172a", **{"text-anchor": "middle", "dominant-baseline": "middle", "font-family": "sans-serif", "font-size": "14"})
        text.text = label[:160]
    return ET.tostring(svg, encoding="unicode")


def main():
    request = json.load(sys.stdin)
    document = parse(request["xml"])
    root = validate(document)
    for operation in request.get("operations", []):
        identifier = operation["cell_id"]
        if identifier in {"0", "1"}:
            raise ValueError("Root and default layer cells cannot be edited")
        existing = next((cell for cell in root if cell.get("id") == identifier), None)
        kind = operation["operation"]
        if kind in {"update", "delete"} and existing is None:
            raise ValueError(f"Unknown cell: {identifier}")
        if kind == "add" and existing is not None:
            raise ValueError(f"Cell already exists: {identifier}")
        if kind in {"update", "delete"}:
            root.remove(existing)
        if kind in {"add", "update"}:
            content = operation.get("xml", "")
            if "<!" in content or "<?" in content:
                raise ValueError("Invalid cell XML")
            cell = ET.fromstring(content)
            if cell.tag != "mxCell" or cell.get("id") != identifier:
                raise ValueError("Replacement must be one mxCell with the selected id")
            root.append(cell)
    root = validate(document)
    print(json.dumps({"xml": ET.tostring(document, encoding="unicode") + "\n", "svg": preview(root) + "\n", "cells": len(root) - 2}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, ET.ParseError) as error:
        sys.exit(str(error))
