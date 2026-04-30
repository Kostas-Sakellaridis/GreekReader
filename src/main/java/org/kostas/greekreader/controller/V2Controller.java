package org.kostas.greekreader.controller;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class V2Controller {

    @GetMapping({"/v2", "/v2/"})
    public String v2() {
        return "forward:/v2/index.html";
    }
}
