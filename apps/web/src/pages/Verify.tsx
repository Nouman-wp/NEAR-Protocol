import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { DisputeView, EpochView, JobView } from "@quorum/core";
import { useApi, useLive } from "../lib/api.ts";
import { verifyEpochInBrowser, type Check } from "../lib/verify.ts";
import { ago } from "../lib/format.ts";
import { AgentChip, Arrow, Empty, Loading, PageHead, Status, Tag } from "../components/ui.tsx";

export default function Verify() {
  const [params, setParams] = useSearchParams();
  const { data: epochs } = useApi<EpochView[]>("/v1/epochs?limit=60");
  const candidates = (epochs ?? []).filter((e) => (e.phase === "sealed" || e.phase === "settling") && e.iouCount > 0);
  const epoch = Number(params.get("epoch") ?? candidates[0]?.id ?? 0);
  const [checks, setChecks] = useState<Check[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [summary, setSummary] = useState<{ ok: boolean; rpc: string; contract: string; receipt: string | null } | null>(null);
  const [failure, setFailure] = useState("");
  // only the latest run may write to the page: an earlier one still finishing is ignored
  const runId = useRef(0);

  const run = async (id: number) => {
    const mine = ++runId.current;
    setChecks([]);
    setSummary(null);
    setState("running");
    try {
      const result = await verifyEpochInBrowser(id, (c) => {
        if (runId.current === mine) setChecks((prev) => [...prev, c]);
      });
      if (runId.current !== mine) return;
      setSummary(result);
      setState("done");
    } catch (err) {
      if (runId.current !== mine) return;
      setFailure((err as Error).message);
      setState("error");
    }
  };
  useEffect(() => {
    if (epoch) void run(epoch);
  }, [epoch]);

  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Verify" title="Don't trust the ledger. Recompute it." lead="This page takes an epoch's published IOUs, reads the buyers' keys and the contract's commitments straight from the NEAR RPC, and redoes the signatures, the netting and the settlement plan in your browser.">
          <select aria-label="Epoch" value={epoch || ""} onChange={(e) => setParams({ epoch: e.target.value })}>
            {candidates.length === 0 && <option value="">no netted epoch yet</option>}
            {candidates.map((e) => (
              <option key={e.id} value={e.id}>
                Epoch {e.id} · {e.iouCount} IOUs
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!epoch || state === "running"} onClick={() => run(epoch)}>
            Run again <Arrow />
          </button>
        </PageHead>
        <div className="grid split">
          <div className="card">
            {!epoch && <Empty>No epoch has been netted yet. Run a scenario on the live floor and close the epoch.</Empty>}
            <div className="chain">
              {checks.map((c) => (
                <div key={c.name} className={`link-step ${c.ok ? "ok" : "fail"}`}>
                  <h4>{c.name}</h4>
                  <p className="muted" style={{ fontSize: 14.5 }}>
                    {c.detail}
                  </p>
                </div>
              ))}
              {state === "running" && (
                <div className="link-step">
                  <h4>Working…</h4>
                </div>
              )}
            </div>
            {state === "error" && <p className="note" style={{ borderColor: "var(--bad)" }}>The check could not finish: {failure}. If the RPC is unreachable from your browser, the same check runs server side at /v1/epochs/{epoch}/verify.</p>}
          </div>
          <div className="stack">
            <div className={`card stat${summary?.ok ? " light" : ""}`}>
              <span className="label">Epoch {epoch || "—"}</span>
              <div>
                <div className="fig" style={{ fontSize: 44 }}>
                  {state === "running" ? "Checking" : summary ? (summary.ok ? "Everything matches" : "Mismatch found") : "—"}
                </div>
                {summary && <small>{checks.filter((c) => c.ok).length} of {checks.length} checks passed</small>}
              </div>
            </div>
            {summary && (
              <div className="card">
                <dl className="kv">
                  <dt>RPC</dt>
                  <dd className="mono">{summary.rpc}</dd>
                  <dt>Contract</dt>
                  <dd className="mono">{summary.contract}</dd>
                  <dt>Receipt</dt>
                  <dd className="mono">{summary.receipt}</dd>
                </dl>
                <p className="note" style={{ marginTop: 18 }}>
                  The IOU list comes from the clearing service. Everything it is compared against comes from the chain, so a service that altered, dropped or invented an IOU would fail these checks.
                </p>
                <Link className="link label" style={{ display: "inline-block", marginTop: 16 }} to={`/epochs/${epoch}`}>
                  Epoch receipt
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export function Disputes() {
  const live = useLive();
  const { data, error } = useApi<(DisputeView & { job: JobView })[]>("/v1/disputes?limit=100", 5_000);
  if (!data) return <Loading error={error} what="disputes" />;
  const upheld = data.filter((d) => d.status === "upheld").length;
  return (
    <main className="page">
      <div className="wrap">
        <PageHead eyebrow="Disputes" title="Bad work is not paid for" lead="A buyer can challenge a delivery inside its window. A staked validator re-checks the work against the job's own specification. If the dispute is upheld, the IOU is voided before netting and the seller's reputation falls.">
          <Tag>{data.length} filed</Tag>
          <Tag kind={upheld ? "bad" : undefined}>{upheld} upheld</Tag>
        </PageHead>
        <div className="card flush">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                  <th>Validator</th>
                  <th>Ruling</th>
                  <th>State</th>
                  <th className="r">Filed</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => {
                  const cur = live.disputes.get(d.id) ?? d;
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link className="link" to={`/jobs/${d.jobId}`}>
                          {d.job.service}
                        </Link>
                      </td>
                      <td>
                        <AgentChip id={d.buyer} />
                      </td>
                      <td>
                        <AgentChip id={d.seller} />
                      </td>
                      <td>
                        <AgentChip id={d.validator} />
                      </td>
                      <td className="muted" style={{ maxWidth: 420 }}>
                        {cur.reasoning ?? d.reason}
                      </td>
                      <td>
                        <Status value={cur.status} />
                      </td>
                      <td className="r faint">{ago(d.filedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.length === 0 && <Empty>No disputes yet. Run the “Rogue attack” scenario on the live floor to see some.</Empty>}
          </div>
        </div>
      </div>
    </main>
  );
}
