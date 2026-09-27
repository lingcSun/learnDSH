public class BareAgent(){

    static final String  API_URL = "";
    static final String  API_KEY = "";
    
    public static void main(String[] args){
        if (API_URL == null || API_URL.isBlank()){
            throw new IllegalStateException("");
        }

        ObjectMapper m = new ObjectMapper();
        HttpClient http = HttpClient.newHttpClient();
        String question = args.length > 0? args[0]:"读当前项目pom.xml";

    }


}