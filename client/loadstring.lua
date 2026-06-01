--[[
  RBX Executor — Cliente Roblox v3
  Escaneo COMPLETO del juego (Workspace, ReplicatedStorage, UI, etc.)
  para que la web entienda todo el contexto al generar scripts.
]]

local API = "https://mcproblox-production.up.railway.app"
local HEARTBEAT_SEC = 1
local SCAN_EVERY = 18

local MAX_TREE_LINES = 160
local MAX_PATH_INDEX = 120
local MAX_DEPTH_WS = 9
local MAX_DEPTH_OTHER = 6

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local LocalPlayer = Players.LocalPlayer
local clientId = tostring(LocalPlayer and LocalPlayer.UserId or math.random(100000, 999999))

local compile = loadstring or load
local waitFn = task and task.wait or wait

local IMPORTANT_CLASSES = {
    Folder = true, Model = true, ScreenGui = true, SurfaceGui = true,
    BillboardGui = true, Tool = true, RemoteEvent = true, RemoteFunction = true,
    BindableEvent = true, BindableFunction = true, ModuleScript = true,
    Script = true, LocalScript = true, ProximityPrompt = true,
    ClickDetector = true, Humanoid = true, NPC = true, Configuration = true,
    Part = true, MeshPart = true, UnionOperation = true, SpawnLocation = true,
}

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

local function isImportant(inst)
    if IMPORTANT_CLASSES[inst.ClassName] then return true end
    if inst:IsA("ValueBase") then return true end
    return false
end

local function shouldRecord(inst, depth)
    if depth <= 3 then return true end
    if isImportant(inst) then return true end
    if inst:IsA("Folder") or inst:IsA("Model") then return true end
    if #inst:GetChildren() > 0 and depth <= 5 then return true end
    return false
end

local function scanFullGame()
    local treeLines = {}
    local paths = {}
    local services = {}
    local stats = { nodes = 0, truncated = false, lines = 0 }

    local function addLine(depth, text)
        if #treeLines >= MAX_TREE_LINES then
            stats.truncated = true
            return false
        end
        table.insert(treeLines, string.rep("  ", depth) .. text)
        stats.lines = #treeLines
        return true
    end

    local function addPath(path, inst, childCount)
        if #paths >= MAX_PATH_INDEX then
            stats.truncated = true
            return
        end
        stats.nodes = stats.nodes + 1
        table.insert(paths, {
            path = path,
            className = inst.ClassName,
            children = childCount,
        })
    end

    local function walk(inst, path, depth, maxDepth, serviceName)
        if depth > maxDepth then return end
        if #treeLines >= MAX_TREE_LINES and #paths >= MAX_PATH_INDEX then
            stats.truncated = true
            return
        end

        local name = inst.Name
        local fullPath = path .. "." .. name
        local kids = inst:GetChildren()
        local childCount = #kids

        if shouldRecord(inst, depth) then
            local label = name .. " [" .. inst.ClassName .. "]"
            if childCount > 0 then
                label = label .. " (" .. childCount .. " hijos)"
            end
            addLine(depth, label)
            addPath(fullPath, inst, childCount)
        end

        table.sort(kids, function(a, b)
            return a.Name < b.Name
        end)

        for _, child in ipairs(kids) do
            if #treeLines >= MAX_TREE_LINES and #paths >= MAX_PATH_INDEX then
                stats.truncated = true
                return
            end
            if depth >= 5 and child:IsA("BasePart") and not child:IsA("SpawnLocation") then
                -- omitir parts genéricos profundos
            else
                walk(child, fullPath, depth + 1, maxDepth, serviceName)
            end
        end
    end

    local function scanRoot(root, label, maxDepth)
        if not root then return end
        local ok, err = pcall(function()
            addLine(0, "=== " .. label .. " ===")
            local kids = root:GetChildren()
            services[label] = #kids
            table.sort(kids, function(a, b) return a.Name < b.Name end)
            for _, child in ipairs(kids) do
                local childPath = label .. "." .. child.Name
                local cc = #child:GetChildren()
                addLine(1, child.Name .. " [" .. child.ClassName .. "]" .. (cc > 0 and (" (" .. cc .. " hijos)") or ""))
                addPath(childPath, child, cc)
                walk(child, label, 1, maxDepth, label)
            end
        end)
        if not ok then
            addLine(0, "=== " .. label .. " (error: " .. tostring(err) .. ") ===")
        end
    end

    scanRoot(workspace, "Workspace", MAX_DEPTH_WS)

    pcall(function() scanRoot(game:GetService("ReplicatedStorage"), "ReplicatedStorage", MAX_DEPTH_OTHER) end)
    pcall(function() scanRoot(game:GetService("ReplicatedFirst"), "ReplicatedFirst", MAX_DEPTH_OTHER) end)
    pcall(function() scanRoot(game:GetService("StarterGui"), "StarterGui", 4) end)
    pcall(function() scanRoot(game:GetService("StarterPack"), "StarterPack", 4) end)

    if LocalPlayer then
        pcall(function()
            local char = LocalPlayer.Character
            if char then
                scanRoot(char, "Character." .. LocalPlayer.Name, 5)
            end
            local pg = LocalPlayer:FindFirstChild("PlayerGui")
            if pg then scanRoot(pg, "PlayerGui", MAX_DEPTH_OTHER) end
        end)
    end

    local playerNames = {}
    for _, p in ipairs(Players:GetPlayers()) do
        table.insert(playerNames, p.Name)
    end

    return {
        version = 3,
        placeId = game.PlaceId,
        gameName = getGameName(),
        scannedAt = tick(),
        playerCount = #playerNames,
        players = playerNames,
        services = services,
        tree = treeLines,
        paths = paths,
        stats = stats,
    }
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

print("[RBX] Escaneo completo del juego activo")
print("[RBX] Jugador: " .. (LocalPlayer and LocalPlayer.Name or "?"))

while true do
    local now = tick()
    if not scanCache or (now - lastScanAt) >= SCAN_EVERY then
        local okScan, scanned = pcall(scanFullGame)
        if okScan and scanned then
            scanCache = scanned
            lastScanAt = now
            local st = scanned.stats or {}
            print("[RBX] 🗺️ Juego escaneado: " .. tostring(st.nodes or 0) .. " rutas · "
                .. tostring(st.lines or 0) .. " líneas"
                .. (st.truncated and " (parcial)" or " (completo)"))
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
