// TOG-5644: route-ID ordering is locale-independent UTF-16 code-unit order.
//
// `String.prototype.localeCompare` follows the process ICU locale: under
// lt_LT "p/y-chat" sorts before "p/k-chat" while under en_US the order flips,
// and case ordering differs from code-unit order. The selection policy
// promises lexicographic route-ID order, so every route-ID sort must use this
// comparator (`<`/`>` semantics) instead of `localeCompare`.

export function compareRouteIds(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
