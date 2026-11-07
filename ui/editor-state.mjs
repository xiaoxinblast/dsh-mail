// A full-document selection includes ProseMirror's trailing empty paragraph.
// It should not hide the list state of the selected, nonempty content.
export function listActive(editor, type) {
  if (editor.isActive(type)) return true;
  const { selection, doc } = editor.state;
  if (selection.empty) return false;
  let found = false, all = true;
  doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (!node.isTextblock || !node.content.size) return;
    found = true;
    const at = doc.resolve(position + 1);
    let nested = false;
    for (let depth = at.depth; depth > 0; depth--) if (at.node(depth).type.name === type) nested = true;
    if (!nested) all = false;
  });
  return found && all;
}
