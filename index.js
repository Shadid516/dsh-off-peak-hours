/**
 * Host half of the Off-Peak Hours bundle.
 *
 * The whole feature is a browser-side decoration: the Client module reads the
 * Session's projected model selection and the current instant, so the Host has
 * nothing to compute, store, or serve. This empty `apply` exists so the plugin
 * occupies a Loader row and shows up in the plugin inventory.
 */

/** Host plugin body — deliberately empty. */
export function apply() {}
