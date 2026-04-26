/**
 * Hermes Kanban — Dashboard Plugin
 *
 * Board view for the multi-agent collaboration board backed by
 * ~/.hermes/kanban.db. Calls the plugin's backend at /api/plugins/kanban/
 * and tails task_events over a WebSocket for live updates.
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn primitives; HTML5 drag-and-drop for card movement (no extra libs).
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) {
    // Dashboard host didn't expose the SDK — nothing we can do.
    return;
  }

  const { React } = SDK;
  const h = React.createElement;
  const {
    Card,
    CardHeader,
    CardTitle,
    CardContent,
    Badge,
    Button,
    Input,
    Label,
    Select,
    SelectOption,
    Separator,
  } = SDK.components;
  const { useState, useEffect, useCallback, useMemo, useRef } = SDK.hooks;
  const { cn, timeAgo } = SDK.utils;

  // Order matters — matches BOARD_COLUMNS in plugin_api.py.
  const COLUMN_ORDER = ["todo", "ready", "running", "blocked", "done"];
  const COLUMN_LABEL = {
    todo: "Todo",
    ready: "Ready",
    running: "In Progress",
    blocked: "Blocked",
    done: "Done",
    archived: "Archived",
  };
  const COLUMN_HELP = {
    todo: "Waiting on dependencies or unassigned",
    ready: "Assigned and waiting for a dispatcher tick",
    running: "Claimed by a worker — in-flight",
    blocked: "Worker asked for human input",
    done: "Completed",
    archived: "Archived",
  };
  const COLUMN_DOT = {
    todo: "hermes-kanban-dot-todo",
    ready: "hermes-kanban-dot-ready",
    running: "hermes-kanban-dot-running",
    blocked: "hermes-kanban-dot-blocked",
    done: "hermes-kanban-dot-done",
    archived: "hermes-kanban-dot-archived",
  };

  const API = "/api/plugins/kanban";

  // -------------------------------------------------------------------------
  // Root page
  // -------------------------------------------------------------------------

  function KanbanPage() {
    const [board, setBoard] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const [tenantFilter, setTenantFilter] = useState("");
    const [assigneeFilter, setAssigneeFilter] = useState("");
    const [includeArchived, setIncludeArchived] = useState(false);
    const [search, setSearch] = useState("");

    const [selectedTaskId, setSelectedTaskId] = useState(null);

    const cursorRef = useRef(0);
    const wsRef = useRef(null);

    // --- fetch full board ---------------------------------------------------
    const loadBoard = useCallback(() => {
      const qs = new URLSearchParams();
      if (tenantFilter) qs.set("tenant", tenantFilter);
      if (includeArchived) qs.set("include_archived", "true");
      const url = qs.toString() ? `${API}/board?${qs}` : `${API}/board`;
      return SDK.fetchJSON(url)
        .then(function (data) {
          setBoard(data);
          cursorRef.current = data.latest_event_id || 0;
          setError(null);
        })
        .catch(function (err) {
          setError(String(err && err.message ? err.message : err));
        })
        .finally(function () {
          setLoading(false);
        });
    }, [tenantFilter, includeArchived]);

    useEffect(function () {
      loadBoard();
    }, [loadBoard]);

    // --- live updates via WebSocket ----------------------------------------
    useEffect(function () {
      if (!board) return undefined;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}${API}/events?since=${cursorRef.current}`;
      let ws;
      let closed = false;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return undefined;
      }
      wsRef.current = ws;
      ws.onmessage = function (ev) {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && Array.isArray(msg.events) && msg.events.length > 0) {
            cursorRef.current = msg.cursor || cursorRef.current;
            // Cheapest correct strategy: reload the board on any event burst.
            // The board endpoint is a single fast SQL query; this is fine.
            loadBoard();
          }
        } catch (e) {
          // ignore malformed frames
        }
      };
      ws.onclose = function () {
        if (!closed) {
          // Auto-reconnect after a short delay.
          setTimeout(function () {
            if (!closed) loadBoard();
          }, 1500);
        }
      };
      return function () {
        closed = true;
        try { ws.close(); } catch (e) { /* noop */ }
      };
    }, [board, loadBoard]);

    // --- filtering ----------------------------------------------------------
    const filteredBoard = useMemo(function () {
      if (!board) return null;
      const q = search.trim().toLowerCase();
      const filterTask = function (t) {
        if (assigneeFilter && t.assignee !== assigneeFilter) return false;
        if (q) {
          const hay = `${t.id} ${t.title || ""} ${t.assignee || ""} ${t.tenant || ""}`.toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      };
      return Object.assign({}, board, {
        columns: board.columns.map(function (col) {
          return Object.assign({}, col, {
            tasks: col.tasks.filter(filterTask),
          });
        }),
      });
    }, [board, assigneeFilter, search]);

    // --- actions ------------------------------------------------------------
    const moveTask = useCallback(function (taskId, newStatus) {
      // Optimistic move: update local board first, reconcile on refresh.
      setBoard(function (b) {
        if (!b) return b;
        let moved = null;
        const columns = b.columns.map(function (col) {
          const next = col.tasks.filter(function (t) {
            if (t.id === taskId) { moved = Object.assign({}, t, { status: newStatus }); return false; }
            return true;
          });
          return Object.assign({}, col, { tasks: next });
        });
        if (moved) {
          const dest = columns.find(function (c) { return c.name === newStatus; });
          if (dest) dest.tasks = [moved].concat(dest.tasks);
        }
        return Object.assign({}, b, { columns: columns });
      });
      SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      })
        .catch(function (err) {
          setError(`Move failed: ${err.message || err}`);
          loadBoard();
        });
    }, [loadBoard]);

    const createTask = useCallback(function (body) {
      return SDK.fetchJSON(`${API}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(loadBoard);
    }, [loadBoard]);

    // --- render -------------------------------------------------------------
    if (loading && !board) {
      return h("div", { className: "p-8 text-sm text-muted-foreground" },
        "Loading Kanban board…");
    }
    if (error && !board) {
      return h(Card, null,
        h(CardContent, { className: "p-6" },
          h("div", { className: "text-sm text-destructive" },
            "Failed to load Kanban board: ", error),
          h("div", { className: "text-xs text-muted-foreground mt-2" },
            "Make sure kanban.db exists (run `hermes kanban init`) and the dashboard was restarted after installing this plugin."),
        ),
      );
    }
    if (!filteredBoard) return null;

    return h("div", { className: "hermes-kanban flex flex-col gap-4" },
      h(BoardToolbar, {
        board: board,
        tenantFilter: tenantFilter,
        setTenantFilter: setTenantFilter,
        assigneeFilter: assigneeFilter,
        setAssigneeFilter: setAssigneeFilter,
        includeArchived: includeArchived,
        setIncludeArchived: setIncludeArchived,
        search: search,
        setSearch: setSearch,
        onNudgeDispatch: function () {
          SDK.fetchJSON(`${API}/dispatch?max=8`, { method: "POST" })
            .then(loadBoard)
            .catch(function (e) { setError(String(e.message || e)); });
        },
        onRefresh: loadBoard,
      }),
      error ? h("div", { className: "text-xs text-destructive px-2" }, error) : null,
      h(BoardColumns, {
        board: filteredBoard,
        onMove: moveTask,
        onOpen: setSelectedTaskId,
        onCreate: createTask,
      }),
      selectedTaskId ? h(TaskDrawer, {
        taskId: selectedTaskId,
        onClose: function () { setSelectedTaskId(null); },
        onRefresh: loadBoard,
      }) : null,
    );
  }

  // -------------------------------------------------------------------------
  // Toolbar (filters + global actions)
  // -------------------------------------------------------------------------

  function BoardToolbar(props) {
    const tenants = (props.board && props.board.tenants) || [];
    const assignees = (props.board && props.board.assignees) || [];

    return h("div", { className: "flex flex-wrap items-end gap-3" },
      h("div", { className: "flex flex-col gap-1" },
        h(Label, { className: "text-xs text-muted-foreground" }, "Search"),
        h(Input, {
          placeholder: "Filter cards…",
          value: props.search,
          onChange: function (e) { props.setSearch(e.target.value); },
          className: "w-56 h-8",
        }),
      ),
      h("div", { className: "flex flex-col gap-1" },
        h(Label, { className: "text-xs text-muted-foreground" }, "Tenant"),
        h(Select, {
          value: props.tenantFilter,
          onChange: function (e) { props.setTenantFilter(e.target.value); },
          className: "h-8",
        },
          h(SelectOption, { value: "" }, "All tenants"),
          tenants.map(function (t) {
            return h(SelectOption, { key: t, value: t }, t);
          }),
        ),
      ),
      h("div", { className: "flex flex-col gap-1" },
        h(Label, { className: "text-xs text-muted-foreground" }, "Assignee"),
        h(Select, {
          value: props.assigneeFilter,
          onChange: function (e) { props.setAssigneeFilter(e.target.value); },
          className: "h-8",
        },
          h(SelectOption, { value: "" }, "All profiles"),
          assignees.map(function (a) {
            return h(SelectOption, { key: a, value: a }, a);
          }),
        ),
      ),
      h("label", { className: "flex items-center gap-2 text-xs" },
        h("input", {
          type: "checkbox",
          checked: props.includeArchived,
          onChange: function (e) { props.setIncludeArchived(e.target.checked); },
        }),
        "Show archived",
      ),
      h("div", { className: "flex-1" }),
      h(Button, {
        onClick: props.onNudgeDispatch,
        className: "h-8 px-3 text-xs border border-border hover:bg-foreground/10 cursor-pointer",
      }, "Nudge dispatcher"),
      h(Button, {
        onClick: props.onRefresh,
        className: "h-8 px-3 text-xs border border-border hover:bg-foreground/10 cursor-pointer",
      }, "Refresh"),
    );
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  function BoardColumns(props) {
    return h("div", { className: "hermes-kanban-columns" },
      props.board.columns.map(function (col) {
        return h(Column, {
          key: col.name,
          column: col,
          onMove: props.onMove,
          onOpen: props.onOpen,
          onCreate: props.onCreate,
        });
      }),
    );
  }

  function Column(props) {
    const [dragOver, setDragOver] = useState(false);
    const [showCreate, setShowCreate] = useState(false);

    const handleDragOver = function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dragOver) setDragOver(true);
    };
    const handleDragLeave = function () { setDragOver(false); };
    const handleDrop = function (e) {
      e.preventDefault();
      setDragOver(false);
      const taskId = e.dataTransfer.getData("text/x-hermes-task");
      if (taskId) props.onMove(taskId, props.column.name);
    };

    return h("div", {
      className: cn(
        "hermes-kanban-column",
        dragOver ? "hermes-kanban-column--drop" : "",
      ),
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
      h("div", { className: "hermes-kanban-column-header" },
        h("span", { className: cn("hermes-kanban-dot", COLUMN_DOT[props.column.name]) }),
        h("span", { className: "hermes-kanban-column-label" },
          COLUMN_LABEL[props.column.name] || props.column.name),
        h("span", { className: "hermes-kanban-column-count" },
          props.column.tasks.length),
        h("button", {
          type: "button",
          className: "hermes-kanban-column-add",
          title: "Create task in this column",
          onClick: function () { setShowCreate(function (v) { return !v; }); },
        }, showCreate ? "×" : "+"),
      ),
      h("div", { className: "hermes-kanban-column-sub" },
        COLUMN_HELP[props.column.name] || ""),
      showCreate ? h(InlineCreate, {
        defaultStatus: props.column.name,
        onSubmit: function (body) {
          props.onCreate(body).then(function () { setShowCreate(false); });
        },
        onCancel: function () { setShowCreate(false); },
      }) : null,
      h("div", { className: "hermes-kanban-column-body" },
        props.column.tasks.length === 0
          ? h("div", { className: "hermes-kanban-empty" }, "— no tasks —")
          : props.column.tasks.map(function (t) {
              return h(TaskCard, {
                key: t.id,
                task: t,
                onOpen: props.onOpen,
              });
            }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Card
  // -------------------------------------------------------------------------

  function TaskCard(props) {
    const t = props.task;

    const handleDragStart = function (e) {
      e.dataTransfer.setData("text/x-hermes-task", t.id);
      e.dataTransfer.effectAllowed = "move";
    };

    return h("div", {
      className: "hermes-kanban-card",
      draggable: true,
      onDragStart: handleDragStart,
      onClick: function () { props.onOpen(t.id); },
    },
      h(Card, null,
        h(CardContent, { className: "hermes-kanban-card-content" },
          h("div", { className: "hermes-kanban-card-row" },
            h("span", { className: "hermes-kanban-card-id" }, t.id),
            t.priority > 0
              ? h(Badge, { className: "hermes-kanban-priority" }, `P${t.priority}`)
              : null,
            t.tenant
              ? h(Badge, { variant: "outline", className: "hermes-kanban-tag" }, t.tenant)
              : null,
          ),
          h("div", { className: "hermes-kanban-card-title" }, t.title || "(untitled)"),
          h("div", { className: "hermes-kanban-card-row hermes-kanban-card-meta" },
            t.assignee
              ? h("span", { className: "hermes-kanban-assignee" }, "@", t.assignee)
              : h("span", { className: "hermes-kanban-unassigned" }, "unassigned"),
            t.comment_count > 0
              ? h("span", { className: "hermes-kanban-count" },
                  "💬 ", t.comment_count)
              : null,
            t.link_counts && (t.link_counts.parents + t.link_counts.children) > 0
              ? h("span", { className: "hermes-kanban-count" },
                  "↔ ", t.link_counts.parents + t.link_counts.children)
              : null,
            h("span", { className: "hermes-kanban-ago" },
              timeAgo ? timeAgo(t.created_at) : ""),
          ),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Inline create
  // -------------------------------------------------------------------------

  function InlineCreate(props) {
    const [title, setTitle] = useState("");
    const [assignee, setAssignee] = useState("");
    const [priority, setPriority] = useState(0);

    const submit = function () {
      const trimmed = title.trim();
      if (!trimmed) return;
      props.onSubmit({
        title: trimmed,
        assignee: assignee.trim() || null,
        priority: Number(priority) || 0,
      });
      setTitle("");
      setAssignee("");
      setPriority(0);
    };

    return h("div", { className: "hermes-kanban-inline-create" },
      h(Input, {
        value: title,
        onChange: function (e) { setTitle(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === "Enter") { e.preventDefault(); submit(); }
          if (e.key === "Escape") props.onCancel();
        },
        placeholder: "New task title…",
        autoFocus: true,
        className: "h-8 text-sm",
      }),
      h("div", { className: "flex gap-2" },
        h(Input, {
          value: assignee,
          onChange: function (e) { setAssignee(e.target.value); },
          placeholder: "assignee (optional)",
          className: "h-7 text-xs flex-1",
        }),
        h(Input, {
          type: "number",
          value: priority,
          onChange: function (e) { setPriority(e.target.value); },
          placeholder: "pri",
          className: "h-7 text-xs w-16",
        }),
      ),
      h("div", { className: "flex gap-2" },
        h(Button, {
          onClick: submit,
          className: "h-7 px-2 text-xs border border-border hover:bg-foreground/10 cursor-pointer flex-1",
        }, "Create"),
        h(Button, {
          onClick: props.onCancel,
          className: "h-7 px-2 text-xs border border-border hover:bg-foreground/10 cursor-pointer",
        }, "Cancel"),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Task drawer (side panel)
  // -------------------------------------------------------------------------

  function TaskDrawer(props) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [newComment, setNewComment] = useState("");

    const load = useCallback(function () {
      return SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(props.taskId)}`)
        .then(function (d) { setData(d); setErr(null); })
        .catch(function (e) { setErr(String(e.message || e)); })
        .finally(function () { setLoading(false); });
    }, [props.taskId]);

    useEffect(function () { load(); }, [load]);

    const handleComment = function () {
      const body = newComment.trim();
      if (!body) return;
      SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(props.taskId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body }),
      }).then(function () {
        setNewComment("");
        load();
        props.onRefresh();
      }).catch(function (e) {
        setErr(String(e.message || e));
      });
    };

    return h("div", { className: "hermes-kanban-drawer-shade", onClick: props.onClose },
      h("div", {
        className: "hermes-kanban-drawer",
        onClick: function (e) { e.stopPropagation(); },
      },
        h("div", { className: "hermes-kanban-drawer-head" },
          h("span", { className: "text-xs text-muted-foreground" }, props.taskId),
          h("button", {
            type: "button",
            onClick: props.onClose,
            className: "hermes-kanban-drawer-close",
            title: "Close",
          }, "×"),
        ),
        loading ? h("div", { className: "p-4 text-sm text-muted-foreground" }, "Loading…") :
        err ? h("div", { className: "p-4 text-sm text-destructive" }, err) :
        data ? h(TaskDetail, {
          data: data,
          onPatch: function (patch) {
            return SDK.fetchJSON(`${API}/tasks/${encodeURIComponent(props.taskId)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            }).then(function () { load(); props.onRefresh(); });
          },
        }) : null,
        data ? h("div", { className: "hermes-kanban-drawer-comment-row" },
          h(Input, {
            value: newComment,
            onChange: function (e) { setNewComment(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault(); handleComment();
              }
            },
            placeholder: "Add a comment… (Enter to submit)",
            className: "h-8 text-sm flex-1",
          }),
          h(Button, {
            onClick: handleComment,
            className: "h-8 px-3 text-xs border border-border hover:bg-foreground/10 cursor-pointer",
          }, "Comment"),
        ) : null,
      ),
    );
  }

  function TaskDetail(props) {
    const t = props.data.task;
    const comments = props.data.comments || [];
    const events = props.data.events || [];
    const links = props.data.links || { parents: [], children: [] };

    return h("div", { className: "hermes-kanban-drawer-body" },
      h("div", { className: "hermes-kanban-drawer-title" },
        h("span", { className: cn("hermes-kanban-dot", COLUMN_DOT[t.status]) }),
        h("span", null, t.title || "(untitled)"),
      ),
      h("div", { className: "hermes-kanban-drawer-meta" },
        h(MetaRow, { label: "Status", value: t.status }),
        h(MetaRow, {
          label: "Assignee",
          value: t.assignee || "unassigned",
        }),
        h(MetaRow, { label: "Priority", value: String(t.priority) }),
        t.tenant ? h(MetaRow, { label: "Tenant", value: t.tenant }) : null,
        h(MetaRow, {
          label: "Workspace",
          value: `${t.workspace_kind}${t.workspace_path ? ": " + t.workspace_path : ""}`,
        }),
        t.created_by ? h(MetaRow, { label: "Created by", value: t.created_by }) : null,
      ),
      h(StatusActions, { task: t, onPatch: props.onPatch }),
      t.body ? h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" }, "Description"),
        h("pre", { className: "hermes-kanban-pre" }, t.body),
      ) : null,
      (links.parents.length > 0 || links.children.length > 0) ?
        h("div", { className: "hermes-kanban-section" },
          h("div", { className: "hermes-kanban-section-head" }, "Dependencies"),
          links.parents.length > 0 ? h("div", { className: "text-xs" },
            "Parents: ",
            links.parents.map(function (id) {
              return h(Badge, { key: id, variant: "outline", className: "ml-1" }, id);
            }),
          ) : null,
          links.children.length > 0 ? h("div", { className: "text-xs mt-1" },
            "Children: ",
            links.children.map(function (id) {
              return h(Badge, { key: id, variant: "outline", className: "ml-1" }, id);
            }),
          ) : null,
        ) : null,
      t.result ? h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" }, "Result"),
        h("pre", { className: "hermes-kanban-pre" }, t.result),
      ) : null,
      h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" }, `Comments (${comments.length})`),
        comments.length === 0
          ? h("div", { className: "text-xs text-muted-foreground" }, "— no comments —")
          : comments.map(function (c) {
              return h("div", { key: c.id, className: "hermes-kanban-comment" },
                h("div", { className: "hermes-kanban-comment-head" },
                  h("span", { className: "hermes-kanban-comment-author" }, c.author || "anon"),
                  h("span", { className: "hermes-kanban-comment-ago" },
                    timeAgo ? timeAgo(c.created_at) : ""),
                ),
                h("pre", { className: "hermes-kanban-pre" }, c.body),
              );
            }),
      ),
      h("div", { className: "hermes-kanban-section" },
        h("div", { className: "hermes-kanban-section-head" }, `Events (${events.length})`),
        events.slice().reverse().slice(0, 20).map(function (e) {
          return h("div", { key: e.id, className: "hermes-kanban-event" },
            h("span", { className: "hermes-kanban-event-kind" }, e.kind),
            h("span", { className: "hermes-kanban-event-ago" },
              timeAgo ? timeAgo(e.created_at) : ""),
            e.payload
              ? h("code", { className: "hermes-kanban-event-payload" },
                  JSON.stringify(e.payload))
              : null,
          );
        }),
      ),
    );
  }

  function MetaRow(props) {
    return h("div", { className: "hermes-kanban-meta-row" },
      h("span", { className: "hermes-kanban-meta-label" }, props.label),
      h("span", { className: "hermes-kanban-meta-value" }, props.value),
    );
  }

  function StatusActions(props) {
    const t = props.task;
    const b = function (label, patch, enabled) {
      return h(Button, {
        onClick: function () { if (enabled !== false) props.onPatch(patch); },
        disabled: enabled === false,
        className: cn(
          "h-7 px-2 text-xs border border-border cursor-pointer",
          enabled === false ? "opacity-40 cursor-not-allowed" : "hover:bg-foreground/10",
        ),
      }, label);
    };

    return h("div", { className: "hermes-kanban-actions" },
      b("→ ready",   { status: "ready" },    t.status !== "ready"),
      b("→ running", { status: "running" },  t.status !== "running"),
      b("Block",     { status: "blocked" },  t.status === "running" || t.status === "ready"),
      b("Unblock",   { status: "ready" },    t.status === "blocked"),
      b("Complete",  { status: "done" },     t.status === "running" || t.status === "ready" || t.status === "blocked"),
      b("Archive",   { status: "archived" }, t.status !== "archived"),
    );
  }

  // -------------------------------------------------------------------------
  // Register
  // -------------------------------------------------------------------------

  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("kanban", KanbanPage);
  }
})();
