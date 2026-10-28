// Reuse unchanged resource references so polling does not restart queries or calendars.
export function reconcileState(previous, next) {
  const result = {};
  for (const [key, value] of Object.entries(next)) {
    const old = previous[key];
    if (Array.isArray(value) && Array.isArray(old)) {
      const byId = new Map(old.filter((item) => item?.id !== undefined).map((item) => [item.id, item]));
      const items = value.map((item, index) => { const candidate = item?.id !== undefined ? byId.get(item.id) : old[index]; return JSON.stringify(candidate) === JSON.stringify(item) ? candidate : item; });
      result[key] = items.length === old.length && items.every((item, index) => item === old[index]) ? old : items;
    } else result[key] = JSON.stringify(old) === JSON.stringify(value) ? old : value;
  }
  return Object.keys(previous).length === Object.keys(result).length && Object.keys(result).every((key) => previous[key] === result[key]) ? previous : result;
}
