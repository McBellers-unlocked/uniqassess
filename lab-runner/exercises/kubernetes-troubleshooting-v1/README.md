# Checkout service incident

You have inherited a small Kubernetes checkout service. A configuration release has
made the service unavailable. Restore service using the cluster, then explain your
diagnosis, the evidence, the changes you made, and how you verified recovery in your
assessment submission.

Success means both checkout replicas are Ready and `curl --max-time 3
http://checkout/checkout` returns HTTP 200 with the expected checkout JSON response.
Preserve the two-replica deployment and its readiness/liveness checks. Do not simply
delete health checks to make the dashboard green.

Start with `kubectl get pods,deployments,services`. You can inspect events, logs,
deployment configuration, endpoints and service routing. Your credentials apply
only to this assessment namespace. The image is preinstalled and approved; the
exercise does not require downloading packages or accessing the public internet.

The console runs one batch command at a time. Multiline shell scripts, pipes and
heredocs are supported. For example, save configuration with
`kubectl get deployment checkout -o yaml > checkout.yaml`, then inspect or modify
the file and use `kubectl apply -f checkout.yaml`. Files under `/workspace` persist
between commands. Each command starts in `/workspace` with a fresh shell, so shell
variables and `cd` do not carry across commands. Interactive editors, interactive
shells and long-running foreground servers are not supported. Use bounded waits
such as `kubectl rollout status deployment/checkout --timeout=10s` and run again if
needed. A command reaching the 20-second limit ends the lab, so always use short
timeouts for networking and watches.

The lab expires when its timer runs out or when your assessment is submitted.
Commands and their output are recorded for your assessor. Credentials, personal
data and unrelated work must not be entered here. This is an assessment cluster,
not a production environment.
