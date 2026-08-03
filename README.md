# Lume

Lume 是一个以 Rust + React 重写的多存储文件浏览器。后端通过 Apache OpenDAL 统一访问本地文件、WebDAV、FTP、SFTP、S3 及挂载后的 Samba/CIFS；前端使用 React、TypeScript、Tailwind CSS 与 shadcn/ui 风格的 Radix 组件。

## 已实现能力

- 多存储浏览、递归搜索、上传、下载、新建目录与递归删除。
- `All connections` 聚合视图，可统一浏览各 target 根目录并跨连接搜索。
- 文件浏览路径同步到可深链 URL，支持浏览器原生前进、后退，以及受 ACL 根路径约束的返回上一级操作。
- SQLite 用户、Argon2id 密码、随机不透明 session，以及 `admin` / `member` 角色。
- 用户可凭当前密码修改自己的用户名和密码，管理员也可编辑或重置任意账户。
- 按 storage 和 path prefix 授予 `read`、`write`、`manage` 权限；管理员拥有隐式全局权限。
- 与用户绑定的可信访问规则：支持来源 IP/CIDR，以及通过可信反向代理校验访问域名。
- Web UI 动态管理用户、路径权限、可信访问规则、OpenDAL 存储连接和运行时设置，数据持久化到 SQLite。
- WebDAV、FTP、SFTP、S3、本地文件系统的 OpenDAL 原生连接；Samba/CIFS 由系统挂载后通过 OpenDAL `fs` accessor 访问。
- 大文件下载使用流式响应；搜索使用有界递归遍历，单次最多扫描 50,000 个条目、返回 500 个结果。

## 本地运行

要求 Rust 1.95+、Node.js 24+。首次启动需要通过环境变量提供非空管理员密码；密码只用于初始化，不写入配置文件。

```bash
npm --prefix frontend install
npm --prefix frontend run build
LUME_ADMIN_PASSWORD='replace-this-password' cargo run -p lume-server
```

打开 `http://127.0.0.1:8080`，使用 `admin` 和上面的密码登录。用户、权限、存储连接和运行时设置都在 Administration 页面管理。

`config.toml` 是可选的 bootstrap 配置，只包含应用启动前必须已知的监听地址、前端静态目录、SQLite 地址和首次管理员初始化方式。文件不存在时默认使用 `0.0.0.0:8080`、`frontend/dist` 和 `sqlite://data/lume.db`；也可以用 `LUME_ADDRESS`、`LUME_FRONTEND_DIST`、`LUME_DATABASE_URL`、`LUME_ADMIN_USERNAME` 覆盖。以下配置保存在 SQLite 并可通过 Web UI 动态更新：

- session 有效期、Secure Cookie、上传大小上限和可信反向代理 CIDR；
- 每个用户的可信访问规则；
- OpenDAL storage connection 及其启停状态；
- 用户、角色和路径权限。

存储凭证不会明文写入 SQLite。Lume 使用 XChaCha20-Poly1305 加密完整连接定义，默认主密钥文件是 `data/lume.key`，权限为 `0600`。生产部署可以使用 `LUME_SECRET_KEY` 或 `LUME_SECRET_KEY_FILE` 注入和托管主密钥；数据库与主密钥必须一起备份。

开发前端时可同时运行：

```bash
LUME_ADMIN_PASSWORD='replace-this-password' cargo run -p lume-server
npm --prefix frontend run dev
```

Vite 会把 `/api` 代理到 `127.0.0.1:8080`。

## Samba/CIFS

OpenDAL 当前没有原生 SMB accessor。Lume 不在应用进程内执行高权限挂载，而是要求操作系统或容器编排层先挂载共享目录，再用 `kind = "smb"` 指向挂载点。这样所有文件操作仍然统一经过 OpenDAL，并避免让 Web 服务持有 `CAP_SYS_ADMIN`。

Linux 示例：

```bash
sudo mount -t cifs //nas.example.com/team /mnt/team-share \
  -o credentials=/etc/lume/smb-credentials,uid=lume,gid=lume,vers=3.1.1
```

挂载完成后，在 Administration → Storage connections 中新增 `Samba mount`，并将 mounted directory 指向 `/mnt/team-share`。

## 免鉴权规则的安全边界

CIDR 规则默认使用 TCP peer address。只有 peer 命中 Web UI 中配置的 trusted proxy CIDR 时，Lume 才读取 `X-Forwarded-For`；只有同一条件成立时才允许 domain 规则匹配 `Host`。反向代理必须覆盖客户端传入的 `Host` 与 `X-Forwarded-For`，不能简单透传。

每条 trusted access rule 都通过稳定的 `user_id` 与用户绑定。规则中的非空 CIDR 与 domains 使用 AND 语义；同一用户的多条规则使用 OR 语义。可信访问只替代密码验证，后续访问仍使用该用户原有的 role 和 path ACL。

登录页在用户名变化后探测当前网络是否满足该用户的规则。命中时隐藏密码输入并创建 `bypass` session；没有命中时仍要求密码。每次使用 bypass session 时后端都会重新校验当前网络和数据库中的规则，因此离开可信网络、禁用规则或禁用用户都会立即使该 session 失效。

## 验证

```bash
cargo fmt --all -- --check
cargo test --workspace
npm --prefix frontend run build
```

## 当前边界与演进方向

实时递归搜索适合中小规模目录，并保证不同 OpenDAL 后端语义一致。百万级对象存储建议下一阶段增加独立索引器与 FTS 表，通过 OpenDAL 的变更扫描增量更新索引；API 边界已经将搜索与目录浏览分开，升级时不需要改变前端契约。
