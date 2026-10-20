# Profiling and capacity

Use `npm run profile -- capture-name` for synthetic local workerd CPU profiles. Captures stay under ignored `.local/profiles/`; these are diagnostic samples, not billed Cloudflare CPU. No private mail or deployment configuration is included in this repository.

Representative HTTP/email/cron CPU measurements passed on a separate staging deployment of the async implementation. New welcome and final-summary paths require deployed CPU validation before launch. Never assume local wall-clock timings prove the Free CPU budget.

The local capacity suite uses 501 and 1,000 subscribers, 104 weekly broadcasts and 69,888 completed scheduler runs. At 1,000 subscribers with adequate SES quota, the newsletter plus weekly owner report and final confirmation finish in 202 scheduled windows (50.5 hours). Peak scheduler/fanout reads plus ten status views are approximately 3.48 million/day, writes approximately 14,590/day, and the synthetic database approximately 140 MB. SES quota 200 takes about 146.5 hours. Real identifiers/content sizes, signup spikes, retries, administrative traffic and shared account usage change these figures.

A partial unfinished-run index avoids scanning all historical scheduler runs on every tick. Private prepared archive pages stream without full-body rendering in HTTP; dashboard rows and previews are bounded. Custom buffered SQL backups were removed in favor of built-in seven-day Free D1 Time Travel. R2 content remains necessary for recovery.
