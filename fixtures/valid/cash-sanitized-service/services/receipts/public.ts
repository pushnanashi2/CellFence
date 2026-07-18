import { getAccountSummary } from "../accounts/public";
import { createPaymentIntent } from "../payments/public";

export function renderReceipt(accountId: string, amountCents: number): string {
  const account = getAccountSummary(accountId);
  const intent = createPaymentIntent(account.accountId, amountCents);
  return `${intent.accountId}:${intent.amountCents}:${intent.approved ? "approved" : "declined"}`;
}
