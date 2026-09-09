import { StringDecoder } from "node:string_decoder";
import { modelClaims } from "../lib/workflow-model-identity.mjs";

export function watchProviderEvents(requestedModel, stop, agent) {
  const decoder = new StringDecoder("utf8");
  const observed = new Set();
  let pending = "";
  const consume = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    const claims = modelClaims(agent, event);
    if (claims.configured.some((model) => model !== requestedModel))
      stop("Client model selection differs from the frozen request");
    for (const { model } of claims.observations) {
      observed.add(model);
      if (model !== requestedModel)
        stop(`Provider model differs from the frozen request: ${model}`);
    }
    if (
      (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") ||
      (event.error && /rate[_ -]?limit|quota|billing|credit/i.test(JSON.stringify(event.error)))
    )
      stop("Provider rate limit or billing error; batch paused");
  };
  return {
    write(chunk) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop();
      lines.forEach(consume);
    },
    end() {
      consume(pending + decoder.end());
      pending = "";
    },
    models: () => [...observed].sort(),
  };
}
