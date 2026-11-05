# open-compute-helm

在 Kubernetes 上部署 [open-compute](https://github.com/elliothux/open-compute) 的 Helm Chart，默认使用上游 `0.4.0` 镜像，支持 Linux AMD64 / ARM64。

open-compute 是单机平台，SQLite、实例主密钥和对象数据由同一个 daemon 管理。本 Chart 使用**单副本 StatefulSet**，不支持通过增加副本实现高可用。无需部署 PostgreSQL、Redis 或 Docker daemon。

## 安装

需要 Helm 3、Kubernetes 1.25+，以及支持动态创建卷的默认 StorageClass。CI 验证 Kubernetes 1.31.6 / 1.32.2。卷需要允许 UID/GID `65532` 读写、执行运行时文件，并允许初始化容器设置目录所有权。集群须允许上游初始化容器以 root 启动；它会切换到非 root 用户执行 daemon。

```bash
kubectl create namespace open-compute
kubectl create secret generic open-compute-auth -n open-compute \
  --from-literal=admin-token="$(openssl rand -hex 32)" \
  --from-literal=deployer-token="$(openssl rand -hex 32)" \
  --from-literal=read-only-token="$(openssl rand -hex 32)"

helm upgrade --install open-compute ./charts/open-compute \
  --namespace open-compute \
  --set auth.existingSecret=open-compute-auth \
  --wait --timeout 10m
```

默认创建 20Gi `ReadWriteOnce` PVC 和端口为 `8787` 的 ClusterIP Service。认证 Secret 必须预先存在，包含三个非空、互不相同的 token；Chart 不把 token 写进 values 或渲染出的资源。

```bash
kubectl port-forward -n open-compute svc/open-compute 8787:8787
# 在另一个终端检查健康状态：
curl -fsS http://127.0.0.1:8787/health/live

# 查看实例及获取一次性 Dashboard 登录链接：
kubectl exec -n open-compute open-compute-0 -c open-compute -- \
  /opt/open-compute/ocd --no-update-check --system instances --json
kubectl exec -n open-compute open-compute-0 -c open-compute -- \
  /opt/open-compute/ocd --no-update-check --system dashboard --no-open
```

使用远程 cf 部署时，先用 `instances --json` 获取实例 ID，再参考上游 [remote targets 文档](https://open-compute.dev/docs/develop/) 配置 `ocd target`。API 地址为 `http://127.0.0.1:8787/client/v4`。

## 配置

完整参数见 [values.yaml](charts/open-compute/values.yaml)。例如：

```yaml
auth:
  existingSecret: open-compute-auth
persistence:
  storageClass: fast-ssd
  size: 50Gi
resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    memory: 4Gi
config:
  publicOrigin: https://compute.example.com
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "64m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  hosts:
    - host: compute.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: compute-tls
      hosts:
        - compute.example.com
```

保存为 `my-values.yaml`，安装时使用 `-f my-values.yaml`。Ingress controller、DNS 和 TLS Secret 需要自行准备。`config.publicOrigin` 是 API 的可访问 origin，用于 Artifacts 和实时日志链接，不能包含路径或结尾 `/`。

这个 Ingress 暴露管理 API / Dashboard。Worker 默认按 `<worker>.<account-id>.localhost` 路由，可通过本地端口转发访问。配置管理 API 域名不会自动注册 Worker 公网域名；后者需要按照上游 [Gateway 文档](https://open-compute.dev/docs/gateway/) 单独配置，本 Chart 不自动设置 Gateway、DNS 或证书。Worker Containers 和 Browser Run 同样需要上游所要求的外部后端。

| 参数 | 说明 |
| --- | --- |
| `image` / `initImage` | 运行 / 初始化镜像；tag 默认跟随 Chart.appVersion，可分别设置 digest |
| `auth.existingSecret` | 必填，已有认证 Secret 名称；键名可通过 `adminKey` / `deployerKey` / `readOnlyKey` 修改 |
| `persistence.existingClaim` | 使用已有 PVC，须确保没有其他 daemon 使用它 |
| `persistence.storageClass` | `null` 使用默认 StorageClass；`""` 仅使用静态卷 |
| `persistence.subPath` | 默认 `open-compute`，避开卷根目录的 `lost+found`；不要在已有安装中修改 |
| `persistence.enabled` | 默认为 `true`；关闭后使用 emptyDir，删除 Pod 会丢失数据，仅供临时测试 |
| `storage.backend` | 默认 `local`；也支持已有 S3 兼容对象存储 |
| `service.type` | `ClusterIP` / `NodePort` / `LoadBalancer` |
| `extraEnv` / `extraEnvFrom` | 为运行容器添加环境变量 / Secret 引用 |

StatefulSet 确保升级时先停止旧 Pod，再启动新 Pod；不要手动扩容、强制删除仍在运行的 Pod，或让多个 release 共享同一个数据目录。

## S3 兼容对象存储

先创建 bucket 和凭据 Secret，再在**首次安装前**选择 S3：

```bash
kubectl create secret generic open-compute-s3 -n open-compute \
  --from-literal=access-key-id="$S3_ACCESS_KEY_ID" \
  --from-literal=secret-access-key="$S3_SECRET_ACCESS_KEY"
```

```yaml
auth:
  existingSecret: open-compute-auth
storage:
  backend: s3
  s3:
    endpoint: https://s3.example.com
    region: us-east-1
    bucket: open-compute
    prefix: open-compute/system/
    r2Prefix: open-compute/tenant/r2/
    existingSecret: open-compute-s3
```

上游初始化流程使用 path-style S3，并执行真实存储预检。每个实例使用独立且互不重叠的 prefix。即使使用 S3，SQLite 和主密钥仍存储在 PVC 中。CI 对 S3 配置进行渲染检查，不连接真实 S3 服务。

## 数据、升级和认证

初始化容器使用上游 `open-compute-init`，创建数据库、主密钥和私有 token 文件，再启动并停止实例，成功后写入初始化标记。后续 Pod 重建复用已有数据；未完成初始化的非空目录会被保留并拒绝重试，需先检查日志进行恢复。

- **认证 token、存储类型、S3 endpoint / bucket / prefix 仅在首次初始化写入。** 修改 Helm values 或 Secret 不会迁移已有数据，也不会轮换已落盘的认证 token。认证轮换应按上游流程维护 PVC 中的私有文件；同步保管 Secret 与数据文件。
- S3 凭据通过环境变量引用；修改 S3 Secret 后需要重建 Pod 才能生效。
- `config.publicOrigin` 在每次启动前更新，变更会自动触发 Pod 替换，保留数据库、密钥和对象存储配置。
- `/health/live` 只用于存活检查；就绪检查还验证 `/health/ready` 和真实实例的 running 状态。
- 升级前备份 PVC 数据及主密钥，并确认上游的数据格式兼容性。`image` 和 `initImage` 必须使用同一版本；不要只更新一个镜像，也不要直接降级已有数据。
- StatefulSet 的 PVC 模板不能通过普通 Helm 升级修改。扩容应按 StorageClass 能力操作已有 PVC，并规划 StatefulSet 的模板更新。
- `helm uninstall open-compute -n open-compute` 会保留 StatefulSet 创建的 PVC。Secret 由用户管理，也会保留。重新安装时使用相同 release 名称、namespace、Secret 和 `subPath`。

诊断命令：

```bash
kubectl describe pod -n open-compute open-compute-0
kubectl logs -n open-compute open-compute-0 -c initialize
kubectl logs -n open-compute open-compute-0 -c configure-origin
kubectl logs -n open-compute open-compute-0 -c open-compute
# 初始化期间的 daemon 日志保存在 PVC 的 init-daemon.log。
```

## GitHub Actions 测试

工作流 [Helm CI](.github/workflows/ci.yaml) 在 `ci` / `main` 分支 push、PR 和手动触发时运行：

1. Helm 严格 lint，渲染默认配置、Ingress、S3、已有 PVC 和临时存储，验证非法配置被拒绝，并打包 Chart。
2. 创建 Kubernetes `1.31.6` / `1.32.2` Kind 集群，真实安装 Chart。
3. 检查 Service DNS、健康状态、非 root 运行、token 认证和只读权限，创建 KV namespace 并写入数据。
4. 删除 Pod，验证实例 ID、主密钥、KV 数据保留且初始化不会重做。
5. 执行 Helm 升级验证 origin 变更，卸载后确认 PVC 保留；上传诊断日志和 Chart 包。

本地静态检查：

```bash
python3 -m pip install PyYAML==6.0.2
helm lint --strict charts/open-compute -f charts/open-compute/ci/default-values.yaml
python3 .github/scripts/check-chart.py
helm package charts/open-compute
```

也可以在一个全新、可丢弃的 Kind 集群运行 `bash .github/scripts/kind-smoke.sh`。脚本会创建 `open-compute` namespace，安装和卸载测试 release，并保留测试 PVC；不要对已有部署运行它。
