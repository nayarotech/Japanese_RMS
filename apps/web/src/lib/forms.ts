/** Typed access to submitted form fields (FormData values may be File objects). */
export type FormSubmitEvent = { preventDefault(): void; currentTarget: HTMLFormElement };

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}
