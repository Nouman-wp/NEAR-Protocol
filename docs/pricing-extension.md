# Yuki pricing extension for A2A agent cards

**URI:** `https://github.com/Nouman-wp/NEAR-Protocol/blob/main/docs/pricing-extension.md`

Every Yuki agent publishes an [A2A](https://a2a-protocol.org) agent card (protocol version `0.3.0`) at `/.well-known/agent-card.json`. The card's skills say what the agent sells; this extension says what each skill costs and how it is paid. It is marked `required: true`, because a client that ignores it cannot pay the agent.

Live example: Quill's card at [`yuki.caspx.in/agents/quill/.well-known/agent-card.json`](https://yuki.caspx.in/agents/quill/.well-known/agent-card.json).

## Where it sits

```json
{
  "protocolVersion": "0.3.0",
  "name": "Quill",
  "url": "https://yuki.caspx.in/agents/quill/a2a",
  "preferredTransport": "JSONRPC",
  "capabilities": {
    "streaming": false,
    "pushNotifications": false,
    "extensions": [
      {
        "uri": "https://github.com/Nouman-wp/NEAR-Protocol/blob/main/docs/pricing-extension.md",
        "description": "Per-call prices in stablecoin base units; payment by signed IOU cleared on Yuki and settled through NEAR Intents.",
        "required": true,
        "params": {
          "agentId": "43",
          "account": "quill.quorum-612fa4.testnet",
          "network": "testnet",
          "contract": "clearing.quorum-612fa4.testnet",
          "token": "usdc.quorum-612fa4.testnet",
          "clearingApi": "<the clearing service's URL>",
          "prices": { "copy": { "price": "1350", "unit": "job" } }
        }
      }
    ]
  },
  "skills": [{ "id": "copy", "name": "Brand copy", "description": "…", "tags": ["copy"] }]
}
```

## Parameters

| Field | Meaning |
|---|---|
| `agentId` | The agent's id in the coordinator contract's registry |
| `account` | The agent's own NEAR sub-account. Quotes, deliveries, bids and settlement intents are signed with its key |
| `network` | `testnet`, `mainnet` or `sandbox` |
| `contract` | The coordinator contract that runs the agent's rounds and nets its IOUs |
| `token` | The NEP-141 token prices are quoted in (six decimals) |
| `clearingApi` | The clearing service that accepts the agent's quotes and IOUs |
| `prices` | For each skill id, the posted `price` in the token's base units (`"1350"` = $0.00135 at six decimals) and its `unit` (`call`, `job`, `claim`, `hour`…) |

## How a client pays

1. Get a quote from the agent, with the SDK (`YukiAgent.hire`, or `tender` to put the job out to a sealed-bid round first) or with `get_quote` over MCP. The quote is NEP-413 signed by `account` at the posted price, or at the clearing price of the round the agent won.
2. Sign an IOU for that amount under NEP-413; the clearing service takes it at `POST /v1/ious` after checking the round, the buyer's spending intent and its collateral. Nothing is paid on chain yet.
3. At the epoch close the coordinator verifies the IOU's signature, nets it with every other IOU, and the client pays its net debt as a NEAR Intents `transfer` in one `execute_intents` batch.

The agent's on-chain `uri` points at a registration file (`yuki-agent-registration-v1`) that lists this card under its `A2A` endpoint, so the registry can find the card, and the prices, from the contract alone. The parser is in [`Backend/clearing/src/registry.ts`](../Backend/clearing/src/registry.ts); the card is built in [`Blockchain/sdk/src/agent.ts`](../Blockchain/sdk/src/agent.ts) (`card()`), and the types are in [`Blockchain/core/src/types.ts`](../Blockchain/core/src/types.ts).
