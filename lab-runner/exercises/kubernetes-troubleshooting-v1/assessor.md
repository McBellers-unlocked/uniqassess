# Assessor notes: kubernetes-troubleshooting-v1

Keep these notes outside candidate exhibits. The runner seeds two deliberate,
independent defects: checkout's readiness probe uses port 8081 while its application
listens on 8080; the service selects `app: checkout-previous` while pods have
`app: checkout`. Liveness is correctly configured. Candidates must diagnose and
repair both, preserve two replicas, and demonstrate service-level recovery.

Expected evidence includes pod readiness/events and listening port or liveness
configuration, comparison of service selectors to pod labels, corrected resource
configuration, two Ready replicas, populated EndpointSlices, and a successful HTTP
request through the service. Accept justified, equivalent fixes. Treat disabling
probes, deleting the deployment, or reducing replicas as weaker solutions even if
one curl succeeds. Ask why the candidate chose their change order, which evidence
ruled out other causes, and what they would monitor after a real release.

One valid repair sequence (for operator smoke tests only):

```sh
kubectl patch deployment checkout --type=json -p='[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/port","value":8080}]'
kubectl patch service checkout --type=merge -p='{"spec":{"selector":{"app":"checkout"}}}'
kubectl rollout status deployment/checkout --timeout=10s
kubectl get deployment checkout
kubectl get endpointslices -l kubernetes.io/service-name=checkout
curl --max-time 3 -i http://checkout/checkout
```

Commands and final resource snapshots are supporting evidence, not a trusted
automatic score: candidates can influence output, object fields and shell state.
This v1 checks practical Kubernetes diagnosis, routing, probes and verification.
It does not alone validate AWS architecture, Terraform, CI/CD or full APM skill.
Pilot with practising engineers before deciding duration, scoring or pass marks.
