export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export const controlClass =
  "min-h-10 rounded-lg border border-[#cbd6cf] bg-white px-3 text-[#17201b] disabled:cursor-not-allowed disabled:opacity-50";

export const buttonClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[#cbd6cf] bg-white px-4 text-[#17201b] transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export const primaryButtonClass = cx(buttonClass, "border-[#1c6b5a] bg-[#1c6b5a] text-white");

export const dangerButtonClass = cx(buttonClass, "border-[#a33b3b] bg-[#a33b3b] text-white");

export const panelClass = "rounded-lg border border-[#dae2dd] bg-white";

export const mutedTextClass = "text-[#647169]";

export const panelHeaderClass = "flex items-center justify-between gap-4";

export const sectionHeadingClass = "m-0";

export const eyebrowClass = "mb-1 text-xs font-bold uppercase tracking-normal text-[#67736d]";
