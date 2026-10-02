---
name: drawio
description: Create or edit a local editable Draw.io architecture diagram, flowchart, or system map from the current conversation without another model service.
---

Use the `drawio` tool. Produce a workspace `.drawio` artifact, not a hosted link.
The current session model creates the XML; no other API key or service is needed.

Generate sibling `mxCell` elements with unique IDs, `parent="1"`, and explicit
geometry. The tool adds the default root/layer and validates references.
Use separate edges with `source` and `target` IDs. Use local basic shapes and
labels; remote images, active content, compressed/multipage documents, and custom
scriptable shapes are outside this small integration.

```xml
<mxCell id="a" value="Client" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;">
  <mxGeometry x="40" y="40" width="140" height="60" as="geometry"/>
</mxCell>
<mxCell id="b" value="Service" vertex="1" parent="1" style="rounded=1;whiteSpace=wrap;html=1;">
  <mxGeometry x="260" y="40" width="140" height="60" as="geometry"/>
</mxCell>
<mxCell id="ab" edge="1" parent="1" source="a" target="b" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

Create with `action: "create", path, xml`. To edit, first read the existing
diagram, then pass its `sha256` as `expected_sha256` and ID-based add/update/delete
operations. Updates include the full replacement cell. Stale hashes refuse edits.
Keep clear spacing, nonoverlapping labels, and short edge routes. Escape XML
attribute values (`&amp;`, `&lt;`, `&quot;`).

The tool also writes `<name>.drawio.svg`, a simple local boxes/connectors preview.
Open it in a browser to inspect the layout; it is not a full Draw.io renderer.
Return links to both files. The `.drawio` opens and remains editable in
diagrams.net Desktop or the VS Code Draw.io extension. Do not upload the document
to a hosted editor unless the user asks.

Inspired by the XML/cell-edit workflow in Apache-2.0-licensed
[next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io), reviewed at
`a45e5b6796ad8ee681ad357bf05446c11ef85fbf`. The web app, provider layer, telemetry,
and prompts are not embedded in OpenCode.
