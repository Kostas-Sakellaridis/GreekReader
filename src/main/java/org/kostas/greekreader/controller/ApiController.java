package org.kostas.greekreader.controller;

import org.kostas.greekreader.service.PerseusService;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ApiController {

    private final PerseusService perseusService;

    public ApiController(PerseusService perseusService) {
        this.perseusService = perseusService;
    }

    @GetMapping(value = "/library", produces = MediaType.APPLICATION_JSON_VALUE)
    public String getLibrary() {
        return perseusService.getLibrary();
    }

    @GetMapping(value = "/reff", produces = MediaType.APPLICATION_JSON_VALUE)
    public String getValidReff(@RequestParam String urn) {
        return perseusService.getWorkToc(urn);
    }

    @GetMapping(value = "/passage", produces = "text/plain;charset=UTF-8")
    public String getPassage(@RequestParam String urn) {
        return perseusService.getPassageText(urn);
    }

    @GetMapping(value = "/morph", produces = MediaType.APPLICATION_XML_VALUE)
    public String getMorphology(@RequestParam String word, @RequestParam(defaultValue = "greek") String lang) {
        return perseusService.getMorphology(word, lang);
    }

    @GetMapping(value = "/define", produces = MediaType.TEXT_HTML_VALUE)
    public String resolveForm(@RequestParam String word, @RequestParam(defaultValue = "greek") String lang) {
        return perseusService.resolveForm(word, lang);
    }
}
