--[[
  RBX Executor — Cliente Roblox v2
  Escanea el Workspace y envía contexto a la web para scripts más precisos.
]]

local API = "https://mcproblox-production.up.railway.app"
local HEARTBEAT_SEC = 1
local SCAN_EVERY = 12

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local LocalPlayer = Players.LocalPlayer
local clientId = tostring(LocalPlayer and LocalPlayer.UserId or math.random(100000, 999999))

local compile = loadstring or load
local waitFn = task and task.wait or wait

local PLOT_KEYWORDS = {
    "plot", "plots", "base", "house", "land", "slot", "claim",
    "farm", "island", "territory", "zone", "stand", "pad", "lot"
}

local function nameMatchesPlot(name)
    local lower = string.lower(name)
    for _, kw in ipairs(PLOT_KEYWORDS) do
        if string.find(lower, kw, 1, true) then
            return true
        end
    end
    return false
end

local function httpRequest(method, url, body)
    local headers = { ["Content-Type"] = "application/json" }

    if syn and syn.request then
        local r = syn.request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and r.Success ~= false and r.Body then return true, r.Body end
        return false, r and r.Body
    end
    if http and http.request then
        local r = http.request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and (r.StatusCode == 200 or r.StatusCode == 201) and r.Body then return true, r.Body end
        return false, r and r.Body
    end
    if request then
        local r = request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and r.Body then return true, r.Body end
    end
    local ok, response = pcall(function()
        if method == "GET" then return HttpService:GetAsync(url, false) end
        return HttpService:PostAsync(url, body or "{}", Enum.HttpContentType.ApplicationJson, false)
    end)
    return ok, response
end

local function getGameName()
    if game and game.Name and game.Name ~= "" then return game.Name end
    return "Place_" .. tostring(game.PlaceId or 0)
end

local function scanWorld()
    local ws = workspace
    local result = {
        placeId = game.PlaceId,
        gameName = getGameName(),
        scannedAt = tick(),
        workspaceChildren = {},
        plots = {},
        notable = {},
        playerCount = #Players:GetPlayers(),
    }

    for _, child in ipairs(ws:GetChildren()) do
        table.insert(result.workspaceChildren, child.Name .. " (" .. child.ClassName .. ")")
    end

    local limit = { n = 0 }
    local MAX = 55

    local function pushEntry(list, path, inst, kids)
        if limit.n >= MAX then return end
        limit.n = limit.n + 1
        local entry = { path = path, className = inst.ClassName }
        if kids and #kids > 0 then entry.children = kids end
        table.insert(list, entry)
    end

    local function sampleChildren(inst)
        local kids = {}
        for _, c in ipairs(inst:GetChildren()) do
            if #kids >= 10 then break end
            table.insert(kids, c.Name)
        end
        return kids
    end

    local function walk(inst, path, depth)
        if depth > 5 or limit.n >= MAX then return end
        local name = inst.Name
        local fullPath = path .. "." .. name

        if nameMatchesPlot(name) then
            pushEntry(result.plots, fullPath, inst, sampleChildren(inst))
        elseif (inst:IsA("Model") or inst:IsA("Folder")) and depth <= 2 and #inst:GetChildren() >= 3 then
            pushEntry(result.notable, fullPath, inst, sampleChildren(inst))
        end

        for _, child in ipairs(inst:GetChildren()) do
            walk(child, fullPath, depth + 1)
        end
    end

    for _, top in ipairs(ws:GetChildren()) do
        local topPath = "Workspace." .. top.Name
        if nameMatchesPlot(top.Name) then
            pushEntry(result.plots, topPath, top, sampleChildren(top))
        end
        for _, child in ipairs(top:GetChildren()) do
            walk(child, topPath, 1)
        end
    end

    return result
end

local function execCode(code)
    if type(code) ~= "string" or code == "" then return false, "Código vacío" end
    local fn, compileErr = compile(code)
    if not fn then return false, "Compile: " .. tostring(compileErr) end
    local ok, runErr = pcall(fn)
    if not ok then return false, tostring(runErr) end
    return true, "OK"
end

local function postJson(path, payload)
    return httpRequest("POST", API .. path, HttpService:JSONEncode(payload))
end

local scanCache = nil
local lastScanAt = 0

print("[RBX] Conectando + escaneo de Workspace activo")
print("[RBX] Jugador: " .. (LocalPlayer and LocalPlayer.Name or "?"))

while true do
    local now = tick()
    if not scanCache or (now - lastScanAt) >= SCAN_EVERY then
        local okScan, scanned = pcall(scanWorld)
        if okScan and scanned then
            scanCache = scanned
            lastScanAt = now
            local n = scanned.plots and #scanned.plots or 0
            print("[RBX] 🗺️ Mapa: " .. n .. " plots/objetos · " .. #(scanned.workspaceChildren or {}) .. " en Workspace")
        end
    end

    local okReq, response = postJson("/api/heartbeat", {
        clientId = clientId,
        player = LocalPlayer and LocalPlayer.Name or "Unknown",
        game = getGameName(),
        worldScan = scanCache,
    })

    if okReq and type(response) == "string" and response ~= "" then
        local okJson, data = pcall(function()
            return HttpService:JSONDecode(response)
        end)

        if okJson and type(data) == "table" then
            if data.clientId then clientId = data.clientId end

            if data.execute and type(data.execute.code) == "string" then
                local exec = data.execute
                print("[RBX] ▶ Ejecutando " .. tostring(exec.id))
                local success, outputOrErr = execCode(exec.code)
                postJson("/api/result", {
                    executionId = exec.id,
                    success = success,
                    output = success and (outputOrErr or "") or "",
                    error = success and "" or (outputOrErr or "Error"),
                })
                if success then print("[RBX] ✓ Listo") else warn("[RBX] ✗ " .. tostring(outputOrErr)) end
            end
        end
    end

    waitFn(HEARTBEAT_SEC)
end
