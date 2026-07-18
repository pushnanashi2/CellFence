import { formatMoney } from "../../shared/src/public";

export function renderPrice(cents: number): string {
  return formatMoney(cents);
}
