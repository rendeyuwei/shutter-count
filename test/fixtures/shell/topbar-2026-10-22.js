"use strict";
(function () {
    const TOOLS = [
        { id: "easypic", name: "EasyPic", d: "图片压缩与格式转换", href: "/easypic/", bg: "#0c0d0f", fg: "#efac4b", m: "EP" },
        { id: "shutter", name: "快门计数", d: "从原图读取快门次数", href: "/shutter/", bg: "#1b1e22", fg: "#efac4b", m: "SC" },
        { id: "recipes", name: "家常菜本", d: "做过的菜，记下来", href: "/recipes/", bg: "#CFE0D6", fg: "#1B3A8C", m: "菜" },
    ];
    const host = window;
    if (host.__rfBar)
        return;
    host.__rfBar = 1;
    const current = document.currentScript;
    const script = current && current.nodeName === "SCRIPT" ? current : null;
    const base = script?.src ? script.src.replace(/topbar\.js.*$/, "") : "/shell/";
    const home = script?.dataset.home || "/";
    let currentId = script?.dataset.tool || "";
    if (!currentId) {
        const path = location.pathname;
        for (const tool of TOOLS) {
            if (path.indexOf(tool.href) === 0)
                currentId = tool.id;
        }
    }
    const active = TOOLS.find((tool) => tool.id === currentId);
    if (!document.querySelector("link[data-rf]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = `${base}topbar.css`;
        link.dataset.rf = "1";
        document.head.appendChild(link);
    }
    const bar = document.createElement("header");
    bar.className = "rf-bar";
    bar.setAttribute("role", "banner");
    const logo = document.createElement("a");
    logo.className = "rf-logo";
    logo.href = home;
    logo.setAttribute("aria-label", "rende.fun 主站");
    logo.innerHTML = '<span class="rf-wm">rende</span><span class="rf-tag">fun</span>';
    bar.appendChild(logo);
    if (active) {
        const sep = document.createElement("span");
        sep.className = "rf-sep";
        const label = document.createElement("span");
        label.className = "rf-cur";
        label.textContent = active.name;
        bar.append(sep, label);
    }
    const spacer = document.createElement("span");
    spacer.className = "rf-sp";
    bar.appendChild(spacer);
    if (active) {
        const back = document.createElement("a");
        back.className = "rf-home";
        back.href = home;
        back.setAttribute("aria-label", "回到主站");
        back.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3 4.5 7l4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="rf-t">回到主站</span>';
        bar.appendChild(back);
    }
    const button = document.createElement("button");
    button.className = "rf-btn";
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "rf-menu");
    button.append("工具 ");
    button.insertAdjacentHTML("beforeend", '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>');
    const menu = document.createElement("nav");
    menu.className = "rf-menu";
    menu.id = "rf-menu";
    menu.setAttribute("aria-label", "切换工具");
    for (const tool of TOOLS) {
        const link = document.createElement("a");
        link.href = tool.href;
        if (tool.id === currentId)
            link.setAttribute("aria-current", "page");
        const swatch = document.createElement("span");
        swatch.className = "rf-sw";
        swatch.style.background = tool.bg;
        swatch.style.color = tool.fg;
        swatch.textContent = tool.m;
        const text = document.createElement("span");
        const name = document.createElement("span");
        name.className = "rf-n";
        name.textContent = tool.name;
        const desc = document.createElement("span");
        desc.className = "rf-d";
        desc.textContent = tool.d;
        text.append(name, desc);
        link.append(swatch, text);
        menu.appendChild(link);
    }
    const rule = document.createElement("hr");
    const all = document.createElement("a");
    all.href = home;
    const allSwatch = document.createElement("span");
    allSwatch.className = "rf-sw";
    allSwatch.style.background = "#2A2D33";
    allSwatch.style.color = "#7FD1AE";
    allSwatch.textContent = "↖";
    const allName = document.createElement("span");
    allName.className = "rf-n";
    allName.textContent = "全部工具";
    all.append(allSwatch, allName);
    menu.append(rule, all);
    bar.append(button, menu);
    const mount = () => {
        document.body.insertBefore(bar, document.body.firstChild);
        document.documentElement.classList.add("rf-has-bar");
    };
    if (document.body)
        mount();
    else
        document.addEventListener("DOMContentLoaded", mount);
    const setOpen = (open) => {
        menu.classList.toggle("open", open);
        button.setAttribute("aria-expanded", open ? "true" : "false");
    };
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = !menu.classList.contains("open");
        setOpen(open);
        if (open)
            menu.querySelector("a")?.focus();
    });
    document.addEventListener("click", (event) => {
        const target = event.target;
        if (!target || !bar.contains(target))
            setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && menu.classList.contains("open")) {
            setOpen(false);
            button.focus();
        }
    });
})();
