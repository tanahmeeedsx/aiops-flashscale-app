# AWS Distributed Load Testing assets

Generate a k6 package from the repo root:

```bash
./scripts/package-dlt-k6.sh \
  --base-url http://EC2_PUBLIC_IP \
  --peak-vus 1000 \
  --order-ratio 0.05
```

Upload the generated zip from `dlt/dist/` in the AWS Distributed Load Testing console as a k6 test.

Recommended sequence:

```text
1k VUs → 5k VUs → 10k VUs → 25k VUs → 50k VUs → 100k VUs
```

For 100k:

```bash
./scripts/package-dlt-k6.sh \
  --base-url http://EC2_PUBLIC_IP \
  --peak-vus 100000 \
  --order-ratio 0.01
```

## Pair DLT with SNS traffic alerts

Before running large tests, set up SNS email alerts from the repo root:

```bash
sudo ./scripts/setup-cloudwatch.sh
sudo ./scripts/setup-sns-alerts.sh
```

Default alerts are based on `NginxRequestCount` per 60 seconds:

```text
10k, 20k, 30k, 40k, 50k, 60k, 70k, 80k, 90k, 100k requests/minute
```

These thresholds are app-side traffic thresholds, not direct virtual-user counts.

---

# AIOps with DLT

For AIOps scenarios, activate a scenario first from the EC2 app, then run the DLT test.

Example:

```bash
curl -X POST http://EC2_PUBLIC_IP/aiops/scenarios/latency
```

Then package and run a k6 DLT test:

```bash
./scripts/package-dlt-k6.sh \
  --base-url http://EC2_PUBLIC_IP \
  --peak-vus 5000 \
  --order-ratio 0.05
```

For queue-backlog or worker-bottleneck demonstrations, use a higher order ratio:

```bash
./scripts/package-dlt-k6.sh \
  --base-url http://EC2_PUBLIC_IP \
  --peak-vus 5000 \
  --order-ratio 0.20
```

Reset after the test:

```bash
curl -X POST http://EC2_PUBLIC_IP/aiops/scenarios/normal
```
