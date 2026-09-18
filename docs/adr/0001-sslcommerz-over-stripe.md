# ADR 0001 — SSLCommerz over Stripe

**Status:** accepted · 2026-09-18

## Decision

Use SSLCommerz (sandbox) as the payment gateway, through `sslcommerz-lts`.

## Why

CityCare charges Bangladeshi citizens in BDT for municipal services. SSLCommerz settles in BDT
and carries the local payment methods people actually have — bKash, Nagad, Rocket, local cards.
Stripe does not support BDT settlement for Bangladeshi merchants, so a Stripe integration would
be a demo that could never go live.

## Alternatives considered

- **Stripe** — better developer experience, unusable for BDT settlement here.
- **bKash direct** — one wallet only; SSLCommerz aggregates bKash plus everything else.
- **Manual bank transfer** — no automatic confirmation, no refunds, unbounded reconciliation work.

## Consequences

- The gateway has no webhook signature, so trust comes from calling its validation API with
  `val_id` and matching `tran_id`, amount and currency against our own row.
- Callbacks arrive as form posts, so the app must parse `urlencoded` bodies.
- Local development needs a public tunnel (`ngrok http 5000`) for callbacks to arrive.
