# Payments (SSLCommerz)

The gateway sends no signed webhook, so **nothing in a callback is believed**. A callback only
tells us to go and ask the validation API what really happened.

## Flow

```
CITIZEN → POST /payments/initiate { serviceRequestId }
  ├─ the request must be owned by the caller and still PENDING_PAYMENT  → else 409 ALREADY_PAID
  ├─ tranId = CC-{timestamp}-{4 random bytes}
  ├─ Payment row PENDING, amount = serviceType.fee        ← always from the database
  ├─ sslcz.init({ total_amount, currency BDT, tran_id, success/fail/cancel/ipn urls, … })
  └─ 201 { paymentId, transactionId, paymentUrl }

citizen pays on the gateway page

SSLCommerz → POST /payments/success   (form data)     and   POST /payments/ipn
  ├─ write the raw payload to PaymentEvent FIRST
  └─ confirm(tran_id, val_id)
```

`confirm()` is the single verification function, shared by the browser redirect and the IPN
webhook, and safe to call any number of times:

```
confirm(tranId, valId)
  ├─ payment by tranId; missing              → 404
  ├─ already SUCCESS                         → return (idempotent)
  ├─ sslcz.validate({ val_id })
  │     status ∈ [VALID, VALIDATED]
  │     && tran_id matches
  │     && Number(amount) === Number(payment.amount)
  │     && currency === "BDT"
  │     any mismatch                         → 400, status stays PENDING
  └─ one transaction:
        payment.updateMany({ where: { id, status: PENDING }, … })
          count === 0 → another request already confirmed it; return
        serviceRequest.status = PAID
        AuditLog PAYMENT_SUCCESS
        Notification
        mark the PaymentEvent rows processed
     then, outside the transaction: render the PDF receipt and email it
```

`/payments/fail` and `/payments/cancel` record the event and move the payment to
`FAILED`/`CANCELLED` **only if it is still PENDING**, so a late callback cannot undo a success.
A citizen may start a new payment after a failure — a new row, a new `tran_id`.

## Why it cannot be forged or double-counted

| Attack | Control |
| --- | --- |
| Fabricated success callback | The gateway is asked directly with `val_id`; a forged id fails validation |
| Tampered amount | The amount is read from `serviceType.fee`, and the amount the gateway reports must match the stored one |
| Replayed callback | `confirm()` returns early when the payment is already SUCCESS |
| Both the redirect and the IPN arriving | `updateMany` filtered on `status: PENDING` — the second one updates 0 rows |
| Two parallel confirmations | Same filter, inside a transaction, plus the `payment_one_success_uq` partial index as the last line of defence |
| Callback flooding | The callback routes are public but rate limited to 20/min |

`PaymentEvent` keeps the raw payload of every callback, so a dispute can be reconstructed from
what the gateway actually sent rather than from what the app concluded.

## Refunds

Two people, two steps:

```
ADMIN       POST  /payments/:id/refund { reason }        → Refund REQUESTED
super admin PATCH /payments/:id/refund/approve
              ├─ sslcz.initiateRefund({ refund_amount, bank_tran_id, … })
              └─ transaction: Refund PROCESSED (gatewayRefId)
                              Payment REFUNDED
                              ServiceRequest CANCELLED
                              AuditLog PAYMENT_REFUNDED + notification
```

The `bank_tran_id` the refund needs comes from the stored `gatewayResponse`; without it the
request is refused rather than guessed.

## Local testing

The gateway has to reach your machine:

```bash
ngrok http 5000
# set BACKEND_URL to the ngrok URL, restart, then call /payments/initiate
```

Sandbox card `4111 1111 1111 1111`, any future expiry, any CVV, OTP `111111`.
